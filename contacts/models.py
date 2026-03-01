from __future__ import annotations
import re
from django.core.exceptions import ValidationError
from django.db import models


PHONE_RE = re.compile(r"^\+?[0-9][0-9\s\-]{6,18}[0-9]$")
def validate_phone(value: str) -> None:
    """
    Very simple phone validation:
    - allows digits, spaces, hyphens and optional leading '+'
    - length constraint to prevent obviously invalid values
    """
    if not PHONE_RE.match(value or ""):
        raise ValidationError("Invalid phone number format.")
    phone_no = value.strip().replace(" ", "").replace("-", "").replace("+", "")
    if len(phone_no) > 12:
        raise ValidationError("Invalid phone number format.")


class ContactStatus(models.Model):
    """
    Status stored in DB (must be ForeignKey from Contact).
    """
    name = models.CharField(max_length=50, unique=True)
    description = models.CharField(max_length=512)

    def __str__(self) -> str:
        return self.name


class Contact(models.Model):
    first_name = models.CharField(max_length=80)
    last_name = models.CharField(max_length=80, db_index=True)

    phone = models.CharField(
        max_length=32,
        unique=True,
        validators=[validate_phone],
        help_text="Digits/spaces/hyphens allowed, optional leading +",
    )
    email = models.EmailField(unique=True)

    city = models.CharField(max_length=120)

    status = models.ForeignKey(
        ContactStatus,
        on_delete=models.PROTECT,
        related_name="contacts",
    )

    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["last_name", "first_name"]
        indexes = [
            models.Index(fields=["last_name"]),
            models.Index(fields=["created_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.first_name} {self.last_name}"