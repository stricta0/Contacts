# Contacts Manager

> **Contacts Manager** is a minimalist, production-oriented web application for managing contacts.
> It provides a Django REST-like API backed by PostgreSQL and a lightweight frontend for browsing, adding, editing, deleting, and importing contacts from CSV.
> Each contact can be enriched with current weather data resolved from the city field via cached external API integrations.

------------------------------------------------------------------------

## Table of Contents

-   [Overview](#overview)
-   [Architecture](#architecture)
-   [Tech Stack](#tech-stack)
-   [Features](#features)
-   [Project Structure](#project-structure)
-   [Installation & Setup](#installation--setup)
-   [Environment Variables](#environment-variables)
-   [API Documentation](#api-documentation)
-   [Database & Migrations](#database--migrations)
-   [Testing](#testing)
-   [Author](#author)

------------------------------------------------------------------------

## Overview

Contacts Manager is a web application for managing contact data through a REST-style API and an interactive frontend interface.

The system allows users to create, update, delete, and browse contacts stored in a PostgreSQL database. Each contact contains structured information such as name, email, phone number, city, and status. Business rules are enforced both at the application and database level to ensure data integrity and consistency.

In addition to standard CRUD operations, the application enriches contacts with real-time weather data based on the city field. External API calls are optimized through caching and deduplication mechanisms to minimize unnecessary network requests and improve performance.

The application is containerized using Docker Compose, ensuring a reproducible and consistent runtime environment.


------------------------------------------------------------------------

## Architecture

Contacts Manager follows a modular Django architecture with a clear
separation between configuration, domain logic, infrastructure, and
frontend assets.

The application consists of the following main components:

-   **Django backend** -- handles routing, business logic, validation,
    database access, and external API integration.
-   **PostgreSQL database** -- persistent data storage for contacts and
    statuses.
-   **Docker & Docker Compose** -- containerized environment ensuring
    reproducible setup.
-   **Frontend (Django templates + vanilla JS)** -- lightweight UI for
    managing contacts via API calls.

### High-Level Flow

    [Browser UI]
          ↓
    [Django Views + API Layer]
          ↓
    [PostgreSQL Database]
          |
          +--> [External APIs]
                  - OpenStreetMap (Nominatim) – geolocation
                  - Open-Meteo – weather data
                  (both cached via Django cache layer)

------------------------------------------------------------------------

### Project Structure

    project/
    ├── config/                 # Django project configuration
    │   ├── settings.py         # Global settings
    │   ├── urls.py             # Root URL configuration
    │   ├── asgi.py / wsgi.py   # Deployment entrypoints
    │
    ├── contacts/               # Domain module
    │   ├── models.py           # Contact & ContactStatus models
    │   ├── api.py              # REST API endpoints
    │   ├── views.py            # Template-rendered views
    │   ├── urls.py             # App-level routing
    │   ├── management/
    │   │   └── commands/
    │   │       └── seed_statuses.py  # Idempotent status seeding
    │   ├── migrations/         # Database migrations
    │   ├── static/contacts/
    │   │   ├── app.js          # Frontend logic (CRUD, sorting, import)
    │   │   └── style.css       # UI styling
    │
    ├── templates/
    │   └── contacts/
    │       └── home.html       # Main UI template
    │
    ├── database/init/          # Database initialization scripts (Docker)
    ├── docker-compose.yml      # Multi-container setup
    ├── Dockerfile              # Backend container definition
    ├── manage.py               # Django CLI entrypoint
    └── requirements.txt        # Python dependencies

------------------------------------------------------------------------

## Tech Stack

- **Python 3.12**
- **Django** (ORM, routing, validation, management commands)
- **PostgreSQL** (relational database)
- **Docker & Docker Compose** (containerized environment)
- **Vanilla JavaScript** (dynamic frontend interactions)
- **HTML5 / CSS3** (UI layer)
- **OpenStreetMap Nominatim API** (geocoding)
- **Open-Meteo API** (weather data)

------------------------------------------------------------------------

## Features

- Full **CRUD operations** for contacts
- Dynamic **contact status management** (database-driven, seeded)
- **CSV import** with structured result logging
- Field-level validation (email format + custom phone validator)
- Database-level uniqueness constraints (email, phone)
- Transaction-safe writes (`transaction.atomic`)
- Weather enrichment based on contact city
- External API response caching (geolocation + weather)
- Server-side query optimization (`select_related`)
- Dockerized, reproducible runtime environment

------------------------------------------------------------------------

## Installation & Setup

### Requirements

-   Docker & Docker Compose\
    or
-   Python 3.12 + PostgreSQL

------------------------------------------------------------------------

### Running with Docker (recommended)

1Build and start containers:

```bash
  docker compose up --build
```
The application will be available at:

http://localhost:8000

Docker workflow automatically: 
- Starts PostgreSQL 
- Applies migrations 
- Seeds default contact statuses 
- Launches Django application

------------------------------------------------------------------------

### Running without Docker (manual setup)

1.  Create virtual environment:

```bash
python -m venv .venv
source .venv/bin/activate
```

2.  Install dependencies:

```bash
pip install -r requirements.txt
```

3.  Configure database connection in `config/settings.py` or via
    environment variables.

4.  Apply migrations:

```bash
python manage.py migrate
```

5.  Seed default statuses:

```bash
python manage.py seed_statuses
```

6.  Start development server:

```bash
python manage.py runserver
```

Application will be available at:

http://127.0.0.1:8000

------------------------------------------------------------------------

## Environment Variables

Link to .env files:
https://drive.google.com/file/d/1CcTQeaSSJr8yg8lPOKoATEV9ButOzc-N/view?usp=sharing

Below are the environment variables required to run the application.

| Variable | Description | Example |
|----------|------------|---------|
| `POSTGRES_DB` | PostgreSQL database name | `contacts` |
| `POSTGRES_USER` | PostgreSQL username | `contacts_user` |
| `POSTGRES_PASSWORD` | PostgreSQL password | `contacts_pass` |
| `POSTGRES_HOST_PORT` | Host port mapped to PostgreSQL container | `5432` |
| `DATABASE_URL` | Full PostgreSQL connection string used by Django | `postgresql://contacts_user:contacts_pass@db:5432/contacts` |
| `DJANGO_ALLOWED_HOSTS` | Comma-separated list of allowed hosts | `localhost,127.0.0.1,0.0.0.0` |
| `DJANGO_SECRET_KEY` | Django cryptographic secret key | `super-long-random-secret` |
| `DJANGO_DEBUG` | Enables/disables debug mode | `true` |
| `DJANGO_TIME_ZONE` | Django application time zone | `Europe/Warsaw` |
| `DJANGO_LOG_LEVEL` | Application log verbosity level | `INFO` |
| `MINS_TO_WEATHER_UPDATE` | Weather cache refresh interval (minutes) | `30` |
| `NOMINATIM_USER_AGENT` | User-Agent header required by Nominatim API | `ContactsManager/1.0 (contact: email@example.com)` |
| `NOMINATIM_SLEEP_SECONDS` | Delay between geolocation API calls | `0.1` |

# API Documentation

Base URL:

    /api/

All responses follow a consistent JSON structure.

Successful response:

``` json
{
  "ok": true
}
```

Error response:

``` json
{
  "ok": false,
  "error": "error_identifier",
  "details": {}
}
```

------------------------------------------------------------------------

# 1️⃣ GET /api/contacts/

Returns all contacts including computed weather data.

Contacts are ordered by:

    last_name → first_name → id

## Example Request

``` bash
curl -s http://localhost:8000/api/contacts/ | python -m json.tool
```

## Example Response

``` json
{
  "ok": true,
  "items": [
    {
      "id": 1,
      "first_name": "Jan",
      "last_name": "Kowalski",
      "phone": "+48 600-700-800",
      "email": "jan.kowalski@example.com",
      "city": "Wroclaw",
      "weather": {
        "temperature": {
          "value": 3.2,
          "unit": "°C",
          "text": "3.2 °C"
        },
        "humidity": {
          "value": 49,
          "unit": "%",
          "text": "49 %"
        },
        "wind": {
          "value": 11,
          "unit": "km/h",
          "text": "11 km/h"
        },
        "weathercode": 3,
        "time": "2026-02-28T14:00"
      },
      "status_id": 1,
      "status": "new",
      "created_at": "2026-02-27T20:10:30.123456"
    }
  ]
}
```

## Status Codes

| Code | Meaning |
|------|---------|
| 200  | Returned successfully |
| 405  | Method not allowed |

------------------------------------------------------------------------

# 2️⃣ POST /api/contacts/

Creates a new contact.

## Required Fields

-   first_name
-   last_name
-   phone
-   email
-   city
-   status_id or status_name

## Example Request

``` bash
curl -X POST http://localhost:8000/api/contacts/   -H "Content-Type: application/json"   -d '{
    "first_name": "Jan",
    "last_name": "Kowalski",
    "phone": "+48 600-700-800",
    "email": "jan.kowalski@example.com",
    "city": "Wroclaw",
    "status_id": 1
  }'
```

## Success Response (201)

``` json
{
  "ok": true,
  "action": "create_contact",
  "message": "created contact: Jan Kowalski",
  "contact": {
    "id": 5,
    "first_name": "Jan",
    "last_name": "Kowalski",
    "phone": "+48 600-700-800",
    "email": "jan.kowalski@example.com",
    "city": "Wroclaw",
    "status": {
      "id": 1,
      "name": "new",
      "description": "New contact"
    },
    "created_at": "2026-03-01T12:10:00.123456"
  }
}
```

## Status Codes

| Code | Meaning |
|------|---------|
| 201  | Contact created |
| 400  | Validation error |
| 409  | Email or phone already exists |
| 405  | Method not allowed |

------------------------------------------------------------------------

# 3️⃣ PUT /api/contacts/{id}/

Updates an existing contact (partial update supported).

## Allowed Fields

-   first_name
-   last_name
-   phone
-   email
-   city
-   status_id

## Example Request

``` bash
curl -X PUT http://localhost:8000/api/contacts/1/   -H "Content-Type: application/json"   -d '{"city":"Warszawa","status_id":2}'
```

## Success Response

``` json
{
  "ok": true,
  "action": "update_contact",
  "contact": {}
}
```

## Status Codes

| Code | Meaning |
|------|---------|
| 200  | Updated successfully |
| 400  | Validation error |
| 404  | Contact not found |
| 409  | Unique constraint violation |
| 405  | Method not allowed |

------------------------------------------------------------------------

# 4️⃣ DELETE /api/contacts/{id}/

Deletes a contact.

## Example Request

``` bash
curl -X DELETE http://localhost:8000/api/contacts/1/
```

## Success Response

``` json
{
  "ok": true,
  "action": "delete_contact",
  "id": 1
}
```

## Status Codes

| Code | Meaning |
|------|---------|
| 200  | Deleted successfully |
| 404  | Contact not found |
| 405  | Method not allowed |

------------------------------------------------------------------------

# 5️⃣ GET /api/contacts/statuses/

Returns available statuses.

## Example Request

``` bash
curl -s http://localhost:8000/api/contacts/statuses/ | python -m json.tool
```

## Example Response

``` json
{
  "ok": true,
  "items": [
    {
      "id": 1,
      "name": "new",
      "description": "New contact"
    }
  ]
}
```

## Status Codes

| Code | Meaning |
|------|---------|
| 200  | Returned successfully |
| 405  | Method not allowed |

------------------------------------------------------------------------

# 6️⃣ POST /api/contacts/import-csv/

Imports contacts from CSV (multipart/form-data, field name: file).

## Example Request

``` bash
curl -X POST http://localhost:8000/api/contacts/import-csv/   -F "file=@contacts.csv"
```

## Success Response

``` json
{
  "ok": true,
  "summary": {
    "ok_count": 5,
    "error_count": 2
  },
  "lines": [
    {
      "line": 2,
      "ok": true,
      "message": "created contact"
    },
    {
      "line": 3,
      "ok": false,
      "message": "email_or_phone_exists"
    }
  ]
}
```

## Status Codes

| Code | Meaning |
|------|---------|
| 200  | Import finished |
| 400  | Invalid CSV |
| 500  | Import failure |
| 405  | Method not allowed |

------------------------------------------------------------------------

## Database & Migrations

### Database

Projekt używa **PostgreSQL** jako głównej bazy danych.

-   Lokalnie (domyślnie) baza działa jako kontener w **Docker Compose**
    (`db`)
-   Aplikacja Django łączy się z bazą przez `DATABASE_URL`
    -   przykładowo:
        `postgresql://contacts_user:contacts_pass@db:5432/contacts`

### Główne tabele (model domenowy)

W bazie znajdują się dwie kluczowe tabele wynikające bezpośrednio z
modeli Django (`contacts/models.py`):

#### `contacts_contactstatus` (ContactStatus)

Tabela ze słownikowymi statusami kontaktu.

-   `id` -- PK (auto)
-   `name` -- **unikalny** identyfikator statusu (np. `new`,
    `in_progress`, `lost`, `outdated`)
-   `description` -- opis statusu (czytelny tekst do UI)

#### `contacts_contact` (Contact)

Tabela z kontaktami.

-   `id` -- PK (auto)
-   `first_name` -- wymagane
-   `last_name` -- wymagane (w projekcie dodatkowo używane do
    sortowania/listowania)
-   `phone` -- wymagane, walidowane, **unikalne**
-   `email` -- wymagane, walidowane (EmailField), **unikalne**
-   `city` -- wymagane
-   `status_id` -- FK do `contacts_contactstatus`
    -   `on_delete=PROTECT` → nie da się usunąć statusu, jeśli istnieją
        kontakty przypięte do niego
-   `created_at` -- timestamp utworzenia rekordu

> Uwaga: pole `weather` nie jest trzymane w bazie --- jest liczone w
> locie w `GET /api/contacts/` na podstawie `city` i cache.

### Migrations

Projekt używa standardowych migracji Django (folder
`contacts/migrations/`).

-   `python manage.py makemigrations` -- generuje nowe migracje na
    podstawie zmian w modelach
-   `python manage.py migrate` -- aplikuje migracje na bazę danych
    (tworzy/aktualizuje tabele)

W repo masz już co najmniej: - `contacts/migrations/0001_initial.py` --
migracja inicjalna tworząca tabele dla aplikacji `contacts`

### Seeding statusów (dane startowe)

Statusy kontaktów są seedowane komendą management command:

-   plik: `contacts/management/commands/seed_statuses.py`
-   uruchomienie:
    -   `python manage.py seed_statuses`

Ta komenda jest **idempotentna** (możesz odpalać wielokrotnie bez
dublowania wpisów) i zapewnia, że UI/API zawsze ma dostępny zestaw
podstawowych statusów.

bazowe statusy to: new, in_progress, lost, inactive i są definiowane w pliku seed_statuses.py

### Typowy workflow uruchomieniowy

#### Docker (rekomendowane)

1.  Start usług:

    ``` bash
    docker compose up --build
    ```

2.  W `docker-compose.yml` kolejność jest ustawiona tak, żeby:

    -   baza wstała i była healthy
    -   poszły migracje
    -   poszedł seed statusów
    -   dopiero potem start web

#### Bez Dockera

``` bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

python manage.py migrate
python manage.py seed_statuses
python manage.py runserver
```

### Jak podejrzeć bazę i tabele (Docker)

``` bash
docker compose exec db psql -U contacts_user -d contacts
```

W psql:

``` sql
\dt
SELECT * FROM contacts_contactstatus;
SELECT * FROM contacts_contact;
```

------------------------------------------------------------------------

## Testing

The project uses Django's built-in testing framework
(`django.test.TestCase`).

Tests are located in:
```txt
contacts/tests.py
```
Example test:
```python
from django.test import TestCase
from django.urls import reverse


class HomeViewTests(TestCase):
    def test_home_returns_200(self):
        url = reverse("contacts:home")
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
```
------------------------------------------------------------------------

### Running Tests (Docker)

Run tests inside the running backend container:
```bash
docker compose exec web python manage.py test
```

If containers are not running:
```bash
docker compose up -d
docker compose exec web python manage.py test
```

------------------------------------------------------------------------

### Running Tests (Without Docker)

If running locally without Docker:

    python manage.py test

Django automatically: - Creates a temporary test database - Applies
migrations - Executes test cases - Destroys the test database after
completion

---------------------------------

## Author

Mikołaj Chiciński