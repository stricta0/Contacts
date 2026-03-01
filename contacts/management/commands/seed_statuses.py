"""
Create default statuses for contacts (new, in_progress, lost, inactive)
"""

from __future__ import annotations

from django.core.management.base import BaseCommand
from django.db import transaction

from contacts.models import ContactStatus

DEFAULT_STATUSES = (
    {"name": "new", "description": "New contact"},
    {"name": "in_progress", "description": "Contact is being processed"},
    {"name": "lost", "description": "Lost contact / no response"},
    {"name": "inactive", "description": "Inactive / outdated"},
)


class Command(BaseCommand):
    """
    Seed default ContactStatus entries (idempotent).
    :param: None
    :return: None
    """

    help = "Seed default ContactStatus entries (idempotent)."

    @transaction.atomic
    def handle(self, *args, **options):
        """
        Create or update default statuses in the database.
        :param args: Positional args (unused).
        :param options: Keyword args (unused).
        :return: None
        """
        created = 0
        updated = 0

        for item in DEFAULT_STATUSES:
            obj, was_created = ContactStatus.objects.update_or_create(
                name=item["name"],
                defaults={"description": item["description"]},
            )
            if was_created:
                created += 1
            else:
                updated += 1

        total = ContactStatus.objects.count()
        self.stdout.write(
            self.style.SUCCESS(
                f"Seeded ContactStatus: created={created}, updated={updated}, total={total}"
            )
        )