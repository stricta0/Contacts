from __future__ import annotations

import csv
import io
import json
import logging
import os
import time
import urllib.parse
import urllib.request
from typing import Any

from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.http import HttpRequest, JsonResponse
from django.views.decorators.csrf import csrf_exempt

from .models import Contact, ContactStatus

logger = logging.getLogger(__name__)

MINS_TO_WEATHER_UPDATE = int(os.getenv("MINS_TO_WEATHER_UPDATE", "30"))
NOMINATIM_USER_AGENT = os.getenv("NOMINATIM_USER_AGENT", "ContactsManager/1.0")
NOMINATIM_SLEEP_SECONDS = float(os.getenv("NOMINATIM_SLEEP_SECONDS", "1.0"))

REQUIRED_CONTACT_FIELDS = ("first_name", "last_name", "phone", "email", "city")


def _bad_request(error: str, *, details: Any | None = None, status: int = 400) -> JsonResponse:
    """
    Build a consistent JSON error response.
    :param error: Error identifier.
    :param details: Optional additional details (serializable).
    :param status: HTTP status code.
    :return: JsonResponse with {"ok": False, "error": ..., "details": ...?}
    """
    payload: dict[str, Any] = {"ok": False, "error": error}
    if details is not None:
        payload["details"] = details
    return JsonResponse(payload, status=status)


def _json_body(request: HttpRequest) -> dict[str, Any] | None:
    """
    Parse request body as JSON.
    :param request: Django HttpRequest.
    :return: Parsed dict, empty dict for empty body, or None if invalid JSON.
    """
    if not request.body:
        return {}
    try:
        return json.loads(request.body.decode("utf-8"))
    except json.JSONDecodeError:
        return None


def _contact_to_dict(c: Contact) -> dict[str, Any]:
    """
    Serialize a Contact model to a JSON-friendly dict.
    :param c: Contact instance.
    :return: Dict representation of the contact.
    """
    return {
        "id": c.id,
        "first_name": c.first_name,
        "last_name": c.last_name,
        "phone": c.phone,
        "email": c.email,
        "city": c.city,
        "status": {
            "id": c.status_id,
            "name": c.status.name,
            "description": c.status.description,
        },
        "created_at": c.created_at.isoformat(),
    }


def _create_status_obj(status_id: Any | None, status_name: Any | None) -> ContactStatus | None:
    """
    Resolve ContactStatus by id or by name.
    :param status_id: Status id (optional).
    :param status_name: Status name (optional).
    :return: ContactStatus instance or None if not found/invalid.
    """
    if status_id is not None and str(status_id).strip() != "":
        try:
            return ContactStatus.objects.get(id=int(status_id))
        except (ValueError, ContactStatus.DoesNotExist):
            return None

    if status_name:
        try:
            return ContactStatus.objects.get(name=str(status_name).strip())
        except ContactStatus.DoesNotExist:
            return None

    return None


def _create_contact_from_payload(payload: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    """
    Create a Contact from an API payload (POST /api/contacts/).
    :param payload: JSON payload with contact fields.
    :return: (True, {"message": ..., "contact": ...}) on success,
             (False, {"error": ..., "missing"/"details": ...}) on failure.
    """
    missing = [k for k in REQUIRED_CONTACT_FIELDS if not payload.get(k)]
    if missing:
        return False, {"error": "missing_required_fields", "missing": missing}

    status_id = payload.get("status_id")
    status_name = payload.get("status_name")
    status_obj = _create_status_obj(status_id, status_name)
    if status_obj is None:
        return False, {
            "error": "invalid_status",
            "details": {"status_id": status_id, "status_name": status_name},
        }

    try:
        with transaction.atomic():
            contact = Contact(
                first_name=str(payload["first_name"]).strip(),
                last_name=str(payload["last_name"]).strip(),
                phone=str(payload["phone"]).strip(),
                email=str(payload["email"]).strip(),
                city=str(payload["city"]).strip(),
                status=status_obj,
            )
            contact.full_clean()
            contact.save()

        contact.status = status_obj
        return True, {
            "message": f"created contact: {contact.first_name} {contact.last_name}",
            "contact": _contact_to_dict(contact),
        }

    except ValidationError as e:
        details = e.message_dict

        # Django catches unique violations (email/phone) during full_clean()
        if "email" in details and "phone" in details:
            return False, {"error": f"{details["email"][0]} && {details["phone"][0]}", "details": details}
        elif "email" in details:
            return False, {"error": f"{details["email"][0]}", "details": details}
        elif "phone" in details:
            return False, {"error": f"{details["phone"][0]}", "details": details}
        else:
            return False, {"error": "Validation error", "details": details}

    except IntegrityError:
        return False, {"error": "email_or_phone_exists"}


def _read_uploaded_file_text(uploaded_file) -> str:
    """
    Read an uploaded file into text safely.
    :param uploaded_file: Django UploadedFile.
    :return: File content as text (utf-8-sig, fallback latin-1).
    """
    raw = uploaded_file.read()
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


def import_contacts_from_csv_file(uploaded_file, *, delimiter: str = ",") -> dict[str, Any]:
    """
    Parse CSV and create contacts.
    :param uploaded_file: Uploaded CSV file (multipart/form-data field "file").
    :param delimiter: CSV delimiter.
    :return: Dict with summary and per-line results.
    """
    if not uploaded_file:
        raise ValueError("missing_file")

    text = _read_uploaded_file_text(uploaded_file)

    try:
        uploaded_file.seek(0)
    except Exception:
        pass

    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)

    if reader.fieldnames is None:
        raise ValueError("csv_missing_header")

    fieldnames_norm = [(x or "").strip().lower() for x in reader.fieldnames]
    if not any(fieldnames_norm):
        raise ValueError("csv_empty_header")

    header_map = {
        "first_name": {"first_name", "firstname", "first name", "imie", "imię"},
        "last_name": {"last_name", "lastname", "last name", "nazwisko"},
        "phone": {"phone", "telefon", "tel"},
        "email": {"email", "e-mail", "mail"},
        "city": {"city", "miasto"},
        "status_id": {"status_id", "statusid"},
        "status_name": {"status_name", "status", "statusname"},
    }

    idx_by_field: dict[str, str] = {}
    for original, norm in zip(reader.fieldnames, fieldnames_norm):
        for target_field, aliases in header_map.items():
            if norm in aliases and target_field not in idx_by_field:
                idx_by_field[target_field] = original

    missing_required_cols = [f for f in REQUIRED_CONTACT_FIELDS if f not in idx_by_field]
    if missing_required_cols:
        raise ValueError(f"csv_missing_required_columns:{','.join(missing_required_cols)}")

    lines: list[dict[str, Any]] = []
    ok_count = 0
    error_count = 0

    for line_no, row in enumerate(reader, start=2):
        if not row or not any((v or "").strip() for v in row.values()):
            continue

        payload: dict[str, Any] = {}
        for field in (*REQUIRED_CONTACT_FIELDS, "status_id", "status_name"):
            col = idx_by_field.get(field)
            if col:
                payload[field] = (row.get(col) or "").strip()

        ok, res = _create_contact_from_payload(payload)
        if ok:
            ok_count += 1
            lines.append({"line": line_no, "ok": True, "message": res.get("message", "created contact")})
        else:
            error_count += 1
            entry: dict[str, Any] = {"line": line_no, "ok": False, "message": res.get("error", "create_failed")}
            if "missing" in res:
                entry["missing"] = res["missing"]
            if "details" in res:
                entry["details"] = res["details"]
            lines.append(entry)

    return {"summary": {"ok_count": ok_count, "error_count": error_count}, "lines": lines}


def _norm_city(city: str) -> str:
    """
    Normalize a city string for consistent matching/caching.
    :param city: City name.
    :return: Normalized city key (lowercase, single-spaced).
    """
    return " ".join((city or "").strip().lower().split())


def _http_get_json(url: str, *, headers: dict[str, str] | None = None, timeout: int = 10) -> Any:
    """
    Fetch URL and parse JSON response.
    :param url: URL to fetch.
    :param headers: Optional HTTP headers.
    :param timeout: Timeout in seconds.
    :return: Parsed JSON (Any).
    """
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read().decode("utf-8")
    return json.loads(data)


def _geo_cache_key(city: str) -> str:
    """
    Build a cache key for geocoding results.
    :param city: Normalized city.
    :return: Cache key.
    """
    return f"geo:v1:{city.lower()}"


def _geocode_cities(cities: list[str]) -> dict[str, dict[str, Any] | None]:
    """
    Geocode cities using Nominatim with caching.
    :param cities: List of city names (may contain duplicates).
    :return: Mapping {normalized_city: {"lat": float, "lon": float} | None}
    """
    unique: list[str] = []
    seen: set[str] = set()
    for c in cities:
        nc = _norm_city(c)
        if not nc:
            continue
        if nc not in seen:
            seen.add(nc)
            unique.append(nc)

    result: dict[str, dict[str, Any] | None] = {}
    to_fetch: list[str] = []

    for city in unique:
        cached = cache.get(_geo_cache_key(city))
        if cached is not None:
            if isinstance(cached, dict) and cached.get("not_found"):
                result[city] = None
            else:
                result[city] = cached
        else:
            to_fetch.append(city)

    headers = {"User-Agent": NOMINATIM_USER_AGENT}

    for city in to_fetch:
        q = urllib.parse.quote(city)
        url = f"https://nominatim.openstreetmap.org/search?q={q}&format=json&limit=1"

        try:
            data = _http_get_json(url, headers=headers, timeout=10)
            if isinstance(data, list) and data:
                payload = {"lat": float(data[0]["lat"]), "lon": float(data[0]["lon"])}
                cache.set(_geo_cache_key(city), payload)
                result[city] = payload
            else:
                cache.set(_geo_cache_key(city), {"not_found": True})
                result[city] = None
        except Exception:
            cache.set(_geo_cache_key(city), {"not_found": True, "temp": True}, timeout=60)
            result[city] = None

        time.sleep(NOMINATIM_SLEEP_SECONDS)

    return result


def _weather_cache_key(lat: float, lon: float) -> str:
    """
    Build a cache key for weather results by coordinates.
    :param lat: Latitude.
    :param lon: Longitude.
    :return: Cache key.
    """
    return f"wx:v1:{lat:.4f}:{lon:.4f}"


def _fmt(value: Any, unit: Any) -> str | None:
    """
    Format a value and unit into a single string.
    :param value: Value to format.
    :param unit: Unit.
    :return: Formatted string or None.
    """
    if value is None:
        return None
    u = str(unit) if unit is not None else ""
    return f"{value} {u}".strip()


def _pick_current(data: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """
    Pick current weather payload supporting two Open-Meteo formats.
    :param data: Open-Meteo API response.
    :return: (current_data, current_units)
    """
    if "current" in data:
        return (data.get("current") or {}, data.get("current_units") or {})
    return (data.get("current_weather") or {}, data.get("current_weather_units") or {})


def _get_weather(cities: list[str]) -> dict[str, Any]:
    """
    Fetch current weather for a list of cities with geocoding and caching.
    :param cities: List of city names (may contain duplicates).
    :return: Mapping {normalized_city: weather_payload | {"error": "..."}}
    """
    city_to_geo = _geocode_cities(cities)

    coord_to_cities: dict[str, list[str]] = {}
    for city, geo in city_to_geo.items():
        if geo is None:
            continue
        k = _weather_cache_key(float(geo["lat"]), float(geo["lon"]))
        coord_to_cities.setdefault(k, []).append(city)

    now_ts = int(time.time())
    max_age = MINS_TO_WEATHER_UPDATE * 60

    weather_by_coord: dict[str, Any] = {}
    to_fetch: list[tuple[str, float, float]] = []

    for k, cities_for_k in coord_to_cities.items():
        cached = cache.get(k)
        if cached and isinstance(cached, dict):
            ts = int(cached.get("ts", 0))
            if now_ts - ts <= max_age and "data" in cached:
                weather_by_coord[k] = cached["data"]
                continue

        first_city = cities_for_k[0]
        geo = city_to_geo[first_city]
        to_fetch.append((k, float(geo["lat"]), float(geo["lon"])))

    for k, lat, lon in to_fetch:
        url = (
            "https://api.open-meteo.com/v1/forecast"
            f"?latitude={lat:.6f}&longitude={lon:.6f}"
            "&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code"
        )
        try:
            data = _http_get_json(url, headers={"User-Agent": NOMINATIM_USER_AGENT}, timeout=10)
            cur, units = _pick_current(data or {})

            temp_val = cur.get("temperature_2m", cur.get("temperature"))
            temp_unit = units.get("temperature_2m", units.get("temperature"))

            hum_val = cur.get("relative_humidity_2m")
            hum_unit = units.get("relative_humidity_2m", "%")

            wind_val = cur.get("wind_speed_10m", cur.get("windspeed"))
            wind_unit = units.get("wind_speed_10m", units.get("windspeed"))

            code_val = cur.get("weather_code", cur.get("weathercode"))
            time_val = cur.get("time")

            payload = {
                "temperature": {"value": temp_val, "unit": temp_unit, "text": _fmt(temp_val, temp_unit)},
                "humidity": (
                    {"value": hum_val, "unit": hum_unit, "text": _fmt(hum_val, hum_unit)}
                    if hum_val is not None
                    else None
                ),
                "wind": {"value": wind_val, "unit": wind_unit, "text": _fmt(wind_val, wind_unit)},
                "weathercode": code_val,
                "time": time_val,
            }

            cache.set(k, {"ts": now_ts, "data": payload}, timeout=24 * 3600)
            weather_by_coord[k] = payload

        except Exception:
            cache.set(k, {"ts": now_ts, "data": {"error": "weather_fetch_failed"}}, timeout=60)
            weather_by_coord[k] = {"error": "weather_fetch_failed"}

    out: dict[str, Any] = {}
    for city in {_norm_city(c) for c in cities if _norm_city(c)}:
        geo = city_to_geo.get(city)
        if geo is None:
            out[city] = {"error": "city_not_found"}
            continue
        k = _weather_cache_key(float(geo["lat"]), float(geo["lon"]))
        out[city] = weather_by_coord.get(k, {"error": "weather_missing"})
    return out


@csrf_exempt
def contacts_collection(request: HttpRequest) -> JsonResponse:
    """
    Handle contacts collection operations (list / create).
    :param request: Django HttpRequest.
    :return: JsonResponse.
    """
    if request.method == "GET":
        return _contacts_list()

    if request.method == "POST":
        return _contacts_create(request)

    return _bad_request("method_not_allowed", status=405)


def _contacts_list() -> JsonResponse:
    """
    List all contacts with computed weather info.
    :param: None
    :return: JsonResponse with items list.
    """
    qs = Contact.objects.select_related("status").order_by("last_name", "first_name", "id")

    cities: list[str] = []
    seen: set[str] = set()
    for c in qs:
        city = _norm_city(c.city)
        if city and city not in seen:
            seen.add(city)
            cities.append(city)

    try:
        weather_map = _get_weather(cities)
    except Exception:
        logger.exception("Weather fetch failed (continuing without weather)")
        weather_map = {}

    items = [
        {
            "id": c.id,
            "first_name": c.first_name,
            "last_name": c.last_name,
            "phone": c.phone,
            "email": c.email,
            "city": c.city,
            "weather": weather_map.get(_norm_city(c.city)),
            "status_id": c.status_id,
            "status": c.status.name,
            "created_at": c.created_at.isoformat(),
        }
        for c in qs
    ]

    logger.debug("Returned %d contacts", len(items))
    return JsonResponse({"ok": True, "items": items})


def _contacts_create(request: HttpRequest) -> JsonResponse:
    """
    Create a new contact from JSON payload.
    :param request: Django HttpRequest.
    :return: JsonResponse.
    """
    payload = _json_body(request)
    if payload is None:
        return _bad_request("invalid_json")

    ok, res = _create_contact_from_payload(payload)
    if ok:
        logger.info("Created contact: %s", res.get("message", ""))
        return JsonResponse({"ok": True, "action": "create_contact", **res}, status=201)

    if res.get("error") == "email_or_phone_exists":
        return _bad_request("email_or_phone_exists", status=409)

    logger.debug("Create contact failed: %s", res)
    return _bad_request(res.get("error", "create_failed"), details=res, status=400)


@csrf_exempt
def contact_item(request: HttpRequest, id: int) -> JsonResponse:
    """
    Handle contact item operations (update / delete).
    :param request: Django HttpRequest.
    :param id: Contact id.
    :return: JsonResponse.
    """
    if request.method == "PUT":
        return _contact_update(request, id)

    if request.method == "DELETE":
        return _contact_delete(id)

    return _bad_request("method_not_allowed", status=405)


def _contact_update(request: HttpRequest, id: int) -> JsonResponse:
    """
    Update an existing contact using a JSON payload.
    :param request: Django HttpRequest.
    :param id: Contact id.
    :return: JsonResponse.
    """
    payload = _json_body(request)
    if payload is None:
        return _bad_request("invalid_json")

    try:
        contact = Contact.objects.select_related("status").get(id=id)
    except Contact.DoesNotExist:
        return _bad_request("contact_not_found", status=404)

    allowed_fields = {"first_name", "last_name", "phone", "email", "city", "status_id"}
    unknown = [k for k in payload.keys() if k not in allowed_fields]
    if unknown:
        return _bad_request("unknown_fields", details={"unknown": unknown})

    if "first_name" in payload:
        contact.first_name = str(payload["first_name"]).strip()
    if "last_name" in payload:
        contact.last_name = str(payload["last_name"]).strip()
    if "phone" in payload:
        contact.phone = str(payload["phone"]).strip()
    if "email" in payload:
        contact.email = str(payload["email"]).strip()
    if "city" in payload:
        contact.city = str(payload["city"]).strip()

    if "status_id" in payload:
        try:
            status_id = int(payload["status_id"])
            status_obj = ContactStatus.objects.get(id=status_id)
        except (ValueError, ContactStatus.DoesNotExist):
            return _bad_request("invalid_status_id")
        contact.status = status_obj

    try:
        with transaction.atomic():
            contact.full_clean()
            contact.save()
    except ValidationError as e:
        details = e.message_dict
        if "email" in details and "phone" in details:
            return JsonResponse({"ok": False, "error": f"{details["email"][0]} && {details["phone"][0]}", "details": details}, status=409)
        elif "email" in details:
            return JsonResponse({"ok": False, "error": f"{details["email"][0]}", "details": details}, status=409)
        elif "phone" in details:
            return JsonResponse({"ok": False, "error": f"{details["phone"][0]}", "details": details}, status=409)
        else:
            return JsonResponse({"ok": False, "error": "Validation error", "details": details}, status=400)
    except IntegrityError:
        return _bad_request("email_or_phone_exists", status=409)

    logger.info("Updated contact id=%s", id)
    return JsonResponse({"ok": True, "action": "update_contact", "contact": _contact_to_dict(contact)})


def _contact_delete(id: int) -> JsonResponse:
    """
    Delete a contact by id.
    :param id: Contact id.
    :return: JsonResponse.
    """
    try:
        Contact.objects.get(id=id).delete()
    except Contact.DoesNotExist:
        return _bad_request("contact_not_found", status=404)

    logger.info("Deleted contact id=%s", id)
    return JsonResponse({"ok": True, "action": "delete_contact", "id": id})


@csrf_exempt
def contact_statuses(request: HttpRequest) -> JsonResponse:
    """
    List contact statuses.
    :param request: Django HttpRequest.
    :return: JsonResponse.
    """
    if request.method != "GET":
        return _bad_request("method_not_allowed", status=405)

    qs = ContactStatus.objects.order_by("id")
    items = [{"id": s.id, "name": s.name, "description": s.description} for s in qs]
    return JsonResponse({"ok": True, "items": items})


@csrf_exempt
def contacts_import_csv(request: HttpRequest) -> JsonResponse:
    """
    Import contacts from a CSV file (multipart/form-data).
    :param request: Django HttpRequest.
    :return: JsonResponse.
    """
    if request.method != "POST":
        return _bad_request("method_not_allowed", status=405)

    f = request.FILES.get("file")
    if not f:
        return _bad_request("missing_file_field", details="file")

    try:
        result = import_contacts_from_csv_file(f, delimiter=",")
        logger.info(
            "CSV import finished ok_count=%s error_count=%s",
            result.get("summary", {}).get("ok_count"),
            result.get("summary", {}).get("error_count"),
        )
        return JsonResponse({"ok": True, **result}, status=200)

    except ValueError as e:
        return _bad_request("invalid_csv", details=str(e), status=400)

    except Exception as e:
        logger.exception("CSV import failed")
        return _bad_request("import_failed", details=str(e), status=500)