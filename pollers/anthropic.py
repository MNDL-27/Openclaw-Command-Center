import json
import urllib.request
import urllib.error
import datetime
import logging
import time
import os

from .base import BasePoller

class AnthropicPoller(BasePoller):
    def __init__(self):
        super().__init__('Anthropic')
        self.api_key = self.get_api_key('ANTHROPIC_API_KEY')
        self.base_url = "https://api.anthropic.com/v1"

    def _get_headers(self):
        return {
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json"
        }

    def poll(self):
        if not self.api_key:
            return None

        # Try to get organization ID first (not standard endpoint, might fail)
        # Or try to get usage directly if we know the endpoint.
        # Currently, Anthropic API doesn't expose a simple "my usage" endpoint for API keys.
        # We might need the user to provide ORG_ID in env too.
        org_id = os.environ.get('ANTHROPIC_ORG_ID')
        
        if not org_id:
            logging.warning("[Anthropic] Missing ANTHROPIC_ORG_ID env var. Cannot poll usage without Org ID.")
            return {'error': 'Missing ANTHROPIC_ORG_ID'}

        # Endpoint: https://api.anthropic.com/v1/organizations/{org_id}/usage_summary
        # Query params: start_date, end_date
        today = datetime.date.today()
        start_date = today.replace(day=1).strftime("%Y-%m-%d")
        end_date = today.strftime("%Y-%m-%d")
        
        url = f"{self.base_url}/organizations/{org_id}/usage_summary?start_date={start_date}&end_date={end_date}"
        
        try:
            req = urllib.request.Request(url, headers=self._get_headers())
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode())
                # structure: {'cost_usd': 12.34, ...} ? 
                # Need to verify response structure. Assuming standard JSON.
                # If they return a list of usage records, we sum them up.
                
                total_cost = 0.0
                if 'cost_usd' in data:
                    total_cost = float(data['cost_usd'])
                elif 'usage' in data and isinstance(data['usage'], list):
                    for u in data['usage']:
                        total_cost += float(u.get('cost_usd', 0))
                
                return {
                    'cost_usd': total_cost,
                    'tokens': 0, # Difficult to aggregate without full scan
                    'meta': {
                        'period': 'month_to_date',
                        'start_date': start_date,
                        'end_date': end_date
                    }
                }
        except urllib.error.HTTPError as e:
            logging.error(f"[Anthropic] API Error {e.code}: {e.reason}")
            return {'error': str(e)}
        except Exception as e:
            logging.error(f"[Anthropic] Error polling usage: {e}")
            return {'error': str(e)}
