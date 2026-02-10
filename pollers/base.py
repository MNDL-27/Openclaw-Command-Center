import logging
import time
import os
import sys

# Try to import db helper
try:
    from dashboard.db import add_usage_point, init_db
except ImportError:
    # If running standalone for testing
    sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from dashboard.db import add_usage_point, init_db

# Configure logger
logger = logging.getLogger("poller")
if not logger.handlers:
    handler = logging.StreamHandler()
    formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

class BasePoller:
    def __init__(self, provider_name):
        self.provider = provider_name
        self.enabled = False
        self.last_run = 0
        self.last_error = None
        self.ensure_db()

    def ensure_db(self):
        try:
            init_db()
        except Exception as e:
            logger.error(f"[{self.provider}] DB init failed: {e}")

    def get_api_key(self, env_var):
        """Get API key from environment variable."""
        key = os.environ.get(env_var)
        if key:
            self.enabled = True
            return key
        logger.warning(f"[{self.provider}] No API key found in {env_var}. Poller disabled.")
        self.enabled = False
        return None

    def poll(self):
        """Override this method to fetch data. Returns dict with 'cost_usd', 'tokens', 'meta'."""
        raise NotImplementedError

    def run(self):
        """Execute the poll and save results."""
        if not self.enabled:
            # Re-check env var if not enabled previously (maybe env changed?)
            # But usually env vars are static per process.
            # We assume the caller checks enablement or we check key here.
            pass

        try:
            logger.info(f"[{self.provider}] Starting poll...")
            start_time = time.time()
            data = self.poll()
            duration = time.time() - start_time
            
            if data:
                cost = data.get('cost_usd', 0.0)
                tokens = data.get('tokens', 0)
                meta = data.get('meta', {})
                
                # Add duration to meta
                meta['duration_s'] = round(duration, 2)
                
                # Save to DB
                add_usage_point(self.provider, 'cost_usd', cost, meta)
                if tokens > 0:
                    add_usage_point(self.provider, 'tokens_total', tokens, meta)
                
                self.last_run = int(time.time())
                self.last_error = None
                logger.info(f"[{self.provider}] Poll success: ${cost} ({tokens} tokens)")
                return {'status': 'success', 'data': data}
            else:
                logger.warning(f"[{self.provider}] Poll returned no data")
                return {'status': 'empty'}
                
        except Exception as e:
            self.last_error = str(e)
            logger.error(f"[{self.provider}] Poll failed: {e}")
            return {'status': 'error', 'error': str(e)}
