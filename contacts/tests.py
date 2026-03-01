from django.test import TestCase
from django.urls import reverse


class HomeViewTests(TestCase):
    def test_home_returns_200(self):
        url = reverse("contacts:home")
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)