from django.urls import path
from . import views
from contacts import api

app_name = "contacts"

urlpatterns = [
    path("", views.home, name="home"),
    path("api/contacts/", api.contacts_collection),
    path("api/contacts/<int:id>/", api.contact_item),
    path("api/contacts/statuses/", api.contact_statuses),
    path("api/contacts/import-csv/", api.contacts_import_csv),
]