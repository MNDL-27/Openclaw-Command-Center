import urllib.request
import logging
import json
import os
import time
from .base import BasePoller

class Context7Poller(BasePoller):
    def __init__(self):
        super().__init__('Context7')
        # Try to load from tokens.json first, then env
        self.api_key = os.environ.get('CONTEXT7_API_KEY')
        if not self.api_key:
            try:
                with open('/home/protik/.openclaw/workspace/.secrets/tokens.json', 'r') as f:
                    tokens = json.load(f)
                    self.api_key = tokens.get('context7_api_key')
            except Exception:
                pass
        
        if self.api_key:
            self.enabled = True
        else:
            self.enabled = False

    def poll(self):
        if not self.api_key:
            return None

        # Minimal query to get headers
        url = "https://context7.com/api/v2/libs/search?libraryName=react&query=check"
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {self.api_key}"
        })

        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                # Read headers
                limit = int(resp.headers.get('ratelimit-limit', 1000))
                remaining = int(resp.headers.get('ratelimit-remaining', 0))
                reset = resp.headers.get('ratelimit-reset', '0')
                
                used = limit - remaining
                
                # We return 'tokens' as the metric for requests here
                return {
                    'cost_usd': 0.0, # Free tier
                    'tokens': used,  # usage count
                    'meta': {
                        'metric': 'requests',
                        'limit': limit,
                        'remaining': remaining,
                        'reset_ts': reset
                    }
                }
        except Exception as e:
            logging.error(f"[Context7] Failed to poll: {e}")
            return {'error': str(e)}
