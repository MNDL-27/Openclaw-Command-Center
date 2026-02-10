import json
import urllib.request
import urllib.error
import datetime
import logging
import time
import os

from .base import BasePoller

class OpenAIPoller(BasePoller):
    def __init__(self):
        super().__init__('OpenAI')
        self.api_key = self.get_api_key('OPENAI_API_KEY')
        self.base_url = "https://api.openai.com/v1"

    def _get_headers(self):
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }

    def fetch_date(self, date_str):
        """Fetch usage for a specific date (YYYY-MM-DD)."""
        # Endpoint: https://api.openai.com/v1/usage?date=YYYY-MM-DD
        url = f"{self.base_url}/usage?date={date_str}"
        try:
            req = urllib.request.Request(url, headers=self._get_headers())
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode())
                # structure: {'data': [...], 'total_usage': 1234 (cents)}
                if 'total_usage' in data:
                    return data['total_usage'] / 100.0  # convert cents to USD
                return 0.0
        except urllib.error.HTTPError as e:
            if e.code == 403 or e.code == 401:
                logging.warning(f"[OpenAI] Permission denied for date {date_str}. Check API key scopes.")
            else:
                logging.warning(f"[OpenAI] HTTP {e.code} for {date_str}: {e}")
            return None
        except Exception as e:
            logging.error(f"[OpenAI] Error fetching {date_str}: {e}")
            return None

    def poll(self):
        if not self.api_key:
            return None

        # Calculate Month-to-Date range
        today = datetime.date.today()
        start_of_month = today.replace(day=1)
        
        # Generate list of dates from start_of_month to today
        delta = (today - start_of_month).days + 1
        dates = [start_of_month + datetime.timedelta(days=i) for i in range(delta)]
        
        total_cost = 0.0
        breakdown = {}
        
        # Safety limit: if loop is > 31 days (weird date math?), cap it
        if len(dates) > 31:
            dates = dates[-31:]

        for d in dates:
            d_str = d.strftime("%Y-%m-%d")
            # Try to fetch
            cost = self.fetch_date(d_str)
            if cost is not None:
                total_cost += cost
                breakdown[d_str] = cost
                # Sleep briefly to avoid rate limits
                time.sleep(0.1)
        
        return {
            'cost_usd': total_cost, 
            'tokens': 0, 
            'meta': {
                'period': 'month_to_date',
                'start_date': start_of_month.strftime("%Y-%m-%d"),
                'breakdown': breakdown
            }
        }
