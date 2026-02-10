#!/usr/bin/env python3
"""
OpenClaw Dashboard - Proxy Server (v6 - Billing Pollers)

Full agent modal support:
- logs endpoint (/proxy/logs)
- memory search (/proxy/memory/search)
- session termination (/proxy/openclaw/sessions/terminate)
- billing pollers (/proxy/pollers)
- notes indexing + watcher (polling)
- threaded HTTP server
"""

import http.server
import socketserver
import urllib.request
import urllib.error
import urllib.parse
import json
import os
import sys
import subprocess
import re
import xml.etree.ElementTree as ET
import threading
import time
import hashlib

# Ensure we can import local modules
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.append(current_dir)

# Import pollers (try/except to allow fallback if modules missing)
try:
    from pollers import ALL_POLLERS
    from db import get_usage_history, get_latest_usage
    POLLERS_AVAILABLE = True
except ImportError as e:
    print(f"[Warning] Poller modules not found: {e}")
    POLLERS_AVAILABLE = False
    ALL_POLLERS = []

PORT = 5555
DASHBOARD_DIR = current_dir
WORKSPACE_DIR = os.path.dirname(DASHBOARD_DIR)
OLLAMA_LOCAL_URL = "http://127.0.0.1:11434"

SETTINGS_PATH = os.path.join(DASHBOARD_DIR, 'settings.json')
NOTES_INDEX_PATH = os.path.join(DASHBOARD_DIR, 'notes_index.json')
LOG_PATH = os.path.join(DASHBOARD_DIR, 'dashboard.log')
OLLAMA_USAGE_PATH = os.path.join(DASHBOARD_DIR, 'ollama_usage.json')

# Global poller instances
POLLER_INSTANCES = []

# --- Simple logger that writes to dashboard.log and stdout ---
def log(msg):
    ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
    line = f"[{ts}] {msg}"
    try:
        with open(LOG_PATH, 'a', encoding='utf-8') as f:
            f.write(line + "\n")
    except Exception as e:
        print(f"[Logger] failed to write log: {e}")
    print(line)


# --- Poller Management ---

def init_pollers():
    global POLLER_INSTANCES
    if not POLLERS_AVAILABLE:
        return
    
    POLLER_INSTANCES = []
    for cls in ALL_POLLERS:
        try:
            p = cls()
            POLLER_INSTANCES.append(p)
            log(f"[Pollers] Initialized {p.provider} (enabled={p.enabled})")
        except Exception as e:
            log(f"[Pollers] Failed to init {cls.__name__}: {e}")

def poller_loop(interval=21600): # Default 6 hours
    if not POLLERS_AVAILABLE:
        return
    
    # Initial delay to let server start
    time.sleep(5)
    
    while True:
        log("[Pollers] Starting scheduled run...")
        ran_count = 0
        for p in POLLER_INSTANCES:
            if p.enabled:
                # Run in a separate thread per poller to avoid blocking loop?
                # For now, serial is fine as they handle their own timeouts.
                try:
                    p.run()
                    ran_count += 1
                except Exception as e:
                    log(f"[Pollers] Error running {p.provider}: {e}")
        
        log(f"[Pollers] Finished run ({ran_count} active). Sleeping {interval}s.")
        time.sleep(interval)


# --- Ollama helpers ---

def get_ollama_local_models():
    """Fetch list of models from local Ollama instance."""
    try:
        req = urllib.request.Request(f"{OLLAMA_LOCAL_URL}/api/tags", headers={'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            return data.get('models', [])
    except Exception as e:
        log(f"[Ollama] failed to fetch local models: {e}")
        return []

def get_ollama_usage():
    """Get Ollama usage stats (local models + cloud usage if saved)."""
    result = {
        'local': {
            'online': False,
            'models': [],
        },
        'cloud': {
            'session_usage': None,
            'session_reset': None,
            'weekly_usage': None,
            'weekly_reset': None,
            'updated_at': None,
        }
    }
    # Local models
    models = get_ollama_local_models()
    if models:
        result['local']['online'] = True
        result['local']['models'] = [
            {
                'name': m.get('name', ''),
                'size': m.get('size', 0),
                'family': m.get('details', {}).get('family', ''),
                'parameters': m.get('details', {}).get('parameter_size', ''),
                'remote': 'remote_host' in m,
            }
            for m in models
        ]
    # Cloud usage (from saved file)
    try:
        if os.path.exists(OLLAMA_USAGE_PATH):
            with open(OLLAMA_USAGE_PATH, 'r', encoding='utf-8') as f:
                saved = json.load(f)
                result['cloud'] = saved.get('cloud', result['cloud'])
    except Exception as e:
        log(f"[Ollama] failed to read saved usage: {e}")
    return result

def save_ollama_cloud_usage(session_usage, session_reset, weekly_usage, weekly_reset):
    """Save manually entered Ollama cloud usage stats."""
    try:
        data = {
            'cloud': {
                'session_usage': session_usage,
                'session_reset': session_reset,
                'weekly_usage': weekly_usage,
                'weekly_reset': weekly_reset,
                'updated_at': int(time.time()),
            }
        }
        with open(OLLAMA_USAGE_PATH, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
        return True
    except Exception as e:
        log(f"[Ollama] failed to save cloud usage: {e}")
        return False


# --- Utility: run OpenClaw CLI (instrumented for usage) ---

USAGE_LOG_PATH = os.path.join(DASHBOARD_DIR, 'usage.log')
USAGE_SUMMARY_PATH = os.path.join(DASHBOARD_DIR, 'usage.json')

def _write_usage_event(event):
    try:
        with open(USAGE_LOG_PATH, 'a', encoding='utf-8') as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
    except Exception as e:
        log(f"[Usage] failed to write event: {e}")

def _update_usage_summary(event):
    try:
        summary = {}
        if os.path.exists(USAGE_SUMMARY_PATH):
            with open(USAGE_SUMMARY_PATH, 'r', encoding='utf-8') as f:
                summary = json.load(f)
        provider = event.get('provider', 'openclaw')
        model = event.get('model', 'unknown')
        if provider == 'openclaw':
            provider = 'Gateway'
        summary.setdefault(provider, {}).setdefault('models', {}).setdefault(model, {'requests': 0, 'last': None})
        summary[provider]['models'][model]['requests'] += 1
        summary[provider]['models'][model]['last'] = event.get('timestamp')
        summary.setdefault('total_requests', 0)
        summary['total_requests'] += 1
        with open(USAGE_SUMMARY_PATH, 'w', encoding='utf-8') as f:
            json.dump(summary, f, indent=2)
    except Exception as e:
        log(f"[Usage] failed to update summary: {e}")

def run_openclaw_cmd(args):
    """Run openclaw CLI command and return JSON output. Instrument calls for usage tracking."""
    start = time.time()
    timestamp = int(start)
    try:
        result = subprocess.run(
            ['openclaw'] + args,
            capture_output=True,
            text=True,
            timeout=30
        )
        duration = time.time() - start
        stdout = result.stdout
        stderr = result.stderr
        try:
            parsed = json.loads(stdout)
        except:
            parsed = {'raw': stdout, 'error': stderr}

        event = {
            'timestamp': timestamp,
            'cmd': ['openclaw'] + args,
            'provider': 'openclaw',
            'model': args[0] if args else 'cli',
            'duration_s': round(duration, 3),
            'result_size': len(stdout) if stdout else 0,
        }
        _write_usage_event(event)
        _update_usage_summary(event)
        return parsed
    except Exception as e:
        duration = time.time() - start
        event = {
            'timestamp': timestamp,
            'cmd': ['openclaw'] + args,
            'provider': 'openclaw',
            'model': args[0] if args else 'cli',
            'duration_s': round(duration, 3),
            'error': str(e),
        }
        _write_usage_event(event)
        _update_usage_summary(event)
        return {'error': str(e)}


# --- RSS / Blog helpers ---

def fetch_rss_items(feed_urls):
    headers = {'User-Agent': 'OpenClawDashboard/1.0'}
    for url in feed_urls:
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = resp.read()
            root = ET.fromstring(data)
            items = []
            for item in root.findall('.//item'):
                title = item.findtext('title') or ''
                link = item.findtext('link') or ''
                pubDate = item.findtext('pubDate') or ''
                desc = item.findtext('description') or ''
                for child in item:
                    if child.tag.lower().endswith('encoded') and child.text:
                        desc = child.text
                        break
                items.append({
                    'title': title,
                    'link': link,
                    'pubDate': pubDate,
                    'description': desc,
                })
            if items:
                return items
        except Exception as e:
            log(f"[Blog] failed to fetch/parse {url}: {e}")
            continue
    return []


def load_settings_file():
    defaults = {
        'hashnode_api_key': None,
        'hashnode_url': 'https://nilasblog.hashnode.dev',
        'publication_id': None,
        'scheduleHour': 23,
        'notes_path': os.path.join(WORKSPACE_DIR, 'LEARNING_NOTES.md'),
        'rss_feeds': [
            "https://example.com/rss.xml",
            "https://nilasblog.hashnode.dev/rss.xml",
            "https://nilasblog.hashnode.dev/rss",
        ],
    }
    try:
        if os.path.exists(SETTINGS_PATH):
            with open(SETTINGS_PATH, 'r', encoding='utf-8') as f:
                user = json.load(f)
            if isinstance(user, dict):
                defaults.update(user)
    except Exception as e:
        log(f"[Settings] failed to read {SETTINGS_PATH}: {e}")

    # Fallback to MEMORY.md for missing values
    mem_path = os.path.join(WORKSPACE_DIR, 'MEMORY.md')
    try:
        if os.path.exists(mem_path):
            with open(mem_path, 'r', encoding='utf-8') as f:
                mem = f.read()
            if not defaults.get('hashnode_api_key'):
                m_key = re.search(r'API Key:\s*([0-9a-fA-F\-]+)', mem)
                if m_key:
                    defaults['hashnode_api_key'] = m_key.group(1).strip()
            if not defaults.get('hashnode_url'):
                m_url = re.search(r'Hashnode URL:\s*(\S+)', mem)
                if m_url:
                    defaults['hashnode_url'] = m_url.group(1).strip()
            if not defaults.get('publication_id'):
                m_pub = re.search(r'Publication ID:\s*([0-9a-fA-F0-9]+)', mem)
                if m_pub:
                    defaults['publication_id'] = m_pub.group(1).strip()
    except Exception as e:
        log(f"[Settings] failed to read MEMORY.md fallback: {e}")

    return defaults


def save_settings_file(settings):
    try:
        with open(SETTINGS_PATH, 'w', encoding='utf-8') as f:
            json.dump(settings, f, indent=2)
        return True
    except Exception as e:
        log(f"[Settings] failed to write {SETTINGS_PATH}: {e}")
        return False


# --- Notes indexing ---

def _safe_id(s):
    # produce a short hex id for a note
    return hashlib.sha1(s.encode('utf-8')).hexdigest()[:12]


def build_notes_index():
    """Scan notes (file or dir) and write notes_index.json with metadata."""
    settings = load_settings_file()
    notes_path = settings.get('notes_path')
    notes = []

    def add_note_obj(title, excerpt, path, mtime):
        note_id = _safe_id(f"{path}::{title}")
        notes.append({
            'id': note_id,
            'title': title,
            'excerpt': excerpt,
            'path': path,
            'mtime': mtime,
        })

    try:
        if notes_path and os.path.exists(notes_path):
            if os.path.isfile(notes_path):
                p = notes_path
                try:
                    with open(p, 'r', encoding='utf-8') as f:
                        content = f.read()
                except Exception as e:
                    log(f"[Notes] failed to read {p}: {e}")
                    content = ''

                parts = re.split(r'\n(?=##\s+)', content)
                if len(parts) > 1:
                    for part in parts:
                        lines = part.strip().split('\n', 1)
                        heading = lines[0].lstrip('# ').strip()
                        excerpt = lines[1].strip()[:800] if len(lines) > 1 else ''
                        mtime = os.path.getmtime(p)
                        add_note_obj(heading, excerpt, p, mtime)
                else:
                    m = re.search(r'^\s*#\s*(.+)$', content, flags=re.M)
                    title = m.group(1).strip() if m else os.path.basename(p)
                    excerpt = content.strip()[:1000]
                    mtime = os.path.getmtime(p)
                    add_note_obj(title, excerpt, p, mtime)
            elif os.path.isdir(notes_path):
                files = sorted([f for f in os.listdir(notes_path) if f.endswith('.md')])[:200]
                for fname in files:
                    fp = os.path.join(notes_path, fname)
                    try:
                        with open(fp, 'r', encoding='utf-8') as f:
                            head = f.read(1200)
                    except Exception as e:
                        log(f"[Notes] failed to read {fp}: {e}")
                        continue
                    m = re.search(r'^\s*#\s*(.+)$', head, flags=re.M)
                    title = m.group(1).strip() if m else os.path.splitext(fname)[0]
                    excerpt = head.strip()[:600]
                    mtime = os.path.getmtime(fp)
                    add_note_obj(title, excerpt, fp, mtime)
        else:
            # fallback
            candidates = ['LEARNING_NOTES.md', 'learning-notes.md', 'notes.md', 'INTERESTS.md', 'LEARNING.md']
            found = False
            for c in candidates:
                p = os.path.join(WORKSPACE_DIR, c)
                if os.path.exists(p) and os.path.isfile(p):
                    found = True
                    try:
                        with open(p, 'r', encoding='utf-8') as f:
                            content = f.read()
                    except Exception as e:
                        log(f"[Notes] failed to read {p}: {e}")
                        continue
                    parts = re.split(r'\n(?=##\s+)', content)
                    if len(parts) > 1:
                        for part in parts:
                            lines = part.strip().split('\n', 1)
                            heading = lines[0].lstrip('# ').strip()
                            excerpt = lines[1].strip()[:800] if len(lines) > 1 else ''
                            mtime = os.path.getmtime(p)
                            add_note_obj(heading, excerpt, p, mtime)
                    else:
                        m = re.search(r'^\s*#\s*(.+)$', content, flags=re.M)
                        title = m.group(1).strip() if m else os.path.basename(p)
                        excerpt = content.strip()[:1000]
                        mtime = os.path.getmtime(p)
                        add_note_obj(title, excerpt, p, mtime)
                    break
            if not found:
                notes_dir = os.path.join(WORKSPACE_DIR, 'notes')
                if os.path.isdir(notes_dir):
                    files = sorted([f for f in os.listdir(notes_dir) if f.endswith('.md')])[:200]
                    for fname in files:
                        fp = os.path.join(notes_dir, fname)
                        try:
                            with open(fp, 'r', encoding='utf-8') as f:
                                head = f.read(1200)
                        except Exception as e:
                            log(f"[Notes] failed to read {fp}: {e}")
                            continue
                        m = re.search(r'^\s*#\s*(.+)$', head, flags=re.M)
                        title = m.group(1).strip() if m else os.path.splitext(fname)[0]
                        excerpt = head.strip()[:600]
                        mtime = os.path.getmtime(fp)
                        add_note_obj(title, excerpt, fp, mtime)

        index = {'indexed_at': int(time.time()), 'notes': notes}
        try:
            with open(NOTES_INDEX_PATH, 'w', encoding='utf-8') as f:
                json.dump(index, f, indent=2)
        except Exception as e:
            log(f"[Notes] failed to write index {NOTES_INDEX_PATH}: {e}")
        return index
    except Exception as e:
        log(f"[Notes] build failed: {e}")
        return {'indexed_at': int(time.time()), 'notes': []}


def read_notes_index():
    try:
        if os.path.exists(NOTES_INDEX_PATH):
            with open(NOTES_INDEX_PATH, 'r', encoding='utf-8') as f:
                return json.load(f)
    except Exception as e:
        log(f"[Notes] failed to read index: {e}")
    # fallback to build on demand
    return build_notes_index()


def notes_watcher(poll_interval=5):
    prev = {}
    while True:
        try:
            settings = load_settings_file()
            notes_path = settings.get('notes_path')
            tracked = []
            if notes_path and os.path.exists(notes_path):
                if os.path.isfile(notes_path):
                    tracked = [os.path.abspath(notes_path)]
                elif os.path.isdir(notes_path):
                    tracked = [os.path.join(notes_path, f) for f in os.listdir(notes_path) if f.endswith('.md')]
            else:
                candidates = ['LEARNING_NOTES.md', 'learning-notes.md', 'notes.md', 'INTERESTS.md', 'LEARNING.md']
                for c in candidates:
                    p = os.path.join(WORKSPACE_DIR, c)
                    if os.path.exists(p) and os.path.isfile(p):
                        tracked.append(p)
                notes_dir = os.path.join(WORKSPACE_DIR, 'notes')
                if os.path.isdir(notes_dir):
                    tracked.extend([os.path.join(notes_dir, f) for f in os.listdir(notes_dir) if f.endswith('.md')])

            current = {}
            changed = False
            for f in tracked:
                try:
                    m = os.path.getmtime(f)
                    current[f] = m
                    if f not in prev or prev.get(f) != m:
                        changed = True
                except Exception:
                    changed = True
            if set(prev.keys()) != set(current.keys()):
                changed = True

            if changed:
                log('[NotesWatcher] change detected — rebuilding index')
                build_notes_index()
                prev = current
        except Exception as e:
            log(f"[NotesWatcher] error: {e}")
        time.sleep(poll_interval)


# --- Blog fetcher (Hashnode) ---

def get_blog_posts():
    settings = load_settings_file()
    api_key = settings.get('hashnode_api_key')
    hashnode_url = settings.get('hashnode_url')
    publication_id = settings.get('publication_id')

    posts = []
    if api_key:
        try:
            if publication_id:
                query = f'{{ publication(id:"{publication_id}") {{ posts(first: 10) {{ edges {{ node {{ title slug url brief coverImage {{ url }} }} }} }} }} }}'
                body = {'query': query}
            else:
                username = None
                if hashnode_url:
                    try:
                        host = re.sub(r'^https?://', '', hashnode_url).split('/')[0]
                        username = host.split('.')[0]
                    except:
                        username = None
                if username:
                    query = f'{{ user(username: "{username}") {{ publication {{ posts(page: 0) {{ title brief slug url coverImage {{ url }} }} }} }} }}'
                    body = {'query': query}
                else:
                    query = '{ user(username: "nilasblog") { publication { posts(page: 0) { title brief slug url coverImage { url } } } } }'
                    body = {'query': query}

            req = urllib.request.Request('https://gql.hashnode.com', data=json.dumps(body).encode('utf-8'),
                                         headers={'Content-Type': 'application/json', 'Authorization': api_key})
            with urllib.request.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read().decode())

            data = result.get('data', {})
            pub = data.get('publication')
            if pub and pub.get('posts'):
                raw = pub['posts']
            else:
                user = data.get('user')
                raw = None
                if user and user.get('publication') and user['publication'].get('posts'):
                    raw = user['publication']['posts']

            if raw:
                if isinstance(raw, dict) and 'edges' in raw:
                    edges = raw.get('edges', [])
                    for e in edges:
                        node = e.get('node', {})
                        title = node.get('title') or ''
                        link = node.get('url') or ''
                        pubDate = node.get('dateAdded') or ''
                        desc = node.get('brief') or ''
                        posts.append({'title': title, 'link': link, 'pubDate': pubDate, 'description': desc})
                elif isinstance(raw, list):
                    for item in raw:
                        title = item.get('title') or ''
                        link = item.get('url') or ''
                        if not link and hashnode_url and item.get('slug'):
                            link = hashnode_url.rstrip('/') + '/' + item.get('slug')
                        pubDate = item.get('dateAdded') or ''
                        desc = item.get('brief') or ''
                        posts.append({'title': title, 'link': link, 'pubDate': pubDate, 'description': desc})

            if posts:
                return {'posts': posts}
        except Exception as e:
            log(f"[Hashnode] GraphQL fetch failed: {e}")

    feed_urls = settings.get('rss_feeds') or [
        "https://example.com/rss.xml",
        "https://nilasblog.hashnode.dev/rss.xml",
        "https://nilasblog.hashnode.dev/rss",
    ]
    items = fetch_rss_items(feed_urls)
    return {'posts': items}


# --- History ---

def get_schedule_history():
    # Check dashboard-local history file
    hist_path = os.path.join(DASHBOARD_DIR, 'schedule_history.json')
    if os.path.exists(hist_path):
        try:
            with open(hist_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            return {'history': data}
        except Exception as e:
            log(f"[History] failed to read {hist_path}: {e}")

    # Fallback: grep MEMORY.md for 'Schedule' lines
    mem_path = os.path.join(WORKSPACE_DIR, 'MEMORY.md')
    if os.path.exists(mem_path):
        try:
            with open(mem_path, 'r', encoding='utf-8') as f:
                text = f.read()
            matches = re.findall(r'.{0,120}Schedule.{0,120}', text)
            return {'history': [{'note': m} for m in matches]}
        except Exception as e:
            log(f"[History] failed to scan MEMORY.md: {e}")

    return {'history': []}


# --- Memory search (simple file search of MEMORY.md) ---

def memory_search(query, max_results=10):
    mem_path = os.path.join(WORKSPACE_DIR, 'MEMORY.md')
    results = []
    if not os.path.exists(mem_path):
        return {'results': []}
    try:
        with open(mem_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        pat = re.compile(re.escape(query), re.I)
        for i, line in enumerate(lines):
            if pat.search(line):
                start = max(0, i-2)
                end = min(len(lines), i+3)
                context = ''.join(lines[start:end]).strip()
                results.append({'line': line.strip(), 'context': context, 'index': i})
                if len(results) >= max_results:
                    break
    except Exception as e:
        log(f"[Memory] search failed: {e}")
    return {'results': results}


# --- Logs helper ---

def tail_lines(path, lines=200):
    try:
        if not os.path.exists(path):
            return ''
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            all_lines = f.readlines()
        return ''.join(all_lines[-lines:])
    except Exception as e:
        log(f"[Logs] tail failed: {e}")
        return ''


# --- HTTP Proxy Handler ---
class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DASHBOARD_DIR, **kwargs)

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        if isinstance(data, str):
            self.wfile.write(data.encode())
        else:
            self.wfile.write(json.dumps(data).encode())

    def do_GET(self):
        full_path = self.path
        path = self.path.split('?')[0]

        # OpenClaw endpoints via CLI
        if path in ['/proxy/openclaw/health', '/proxy/openclaw/api/health']:
            output = run_openclaw_cmd(['health', '--json'])
            self.send_json(output)
            return
        elif path in ['/proxy/openclaw/sessions', '/proxy/openclaw/api/sessions']:
            output = run_openclaw_cmd(['sessions', 'list', '--json'])
            self.send_json(output)
            return
        elif path in ['/proxy/openclaw/cron', '/proxy/openclaw/cron/list', '/proxy/openclaw/api/cron/list']:
            output = run_openclaw_cmd(['cron', 'list', '--json'])
            self.send_json(output)
            return
        elif path in ['/proxy/openclaw/status', '/proxy/openclaw/api/status']:
            output = run_openclaw_cmd(['status', '--json'])
            self.send_json(output)
            return

        # Pollers status
        if path == '/proxy/pollers/status':
            status = []
            for p in POLLER_INSTANCES:
                # Use DB helper to get latest cost if missing from memory
                latest_cost = None
                latest_tokens = None
                latest_meta = None
                if POLLERS_AVAILABLE:
                    from db import get_latest_usage
                    latest = get_latest_usage(p.provider)
                    if latest:
                        latest_cost = latest['cost_usd']
                        latest_tokens = latest.get('tokens_total')
                        latest_meta = latest.get('meta')
                
                status.append({
                    'provider': p.provider,
                    'enabled': p.enabled,
                    'last_run': p.last_run,
                    'last_error': p.last_error,
                    'latest_cost_usd': latest_cost,
                    'latest_tokens': latest_tokens,
                    'latest_meta': latest_meta
                })
            self.send_json({'pollers': status})
            return

        # Pollers history (for charts)
        if path == '/proxy/pollers/history':
            qs = urllib.parse.urlparse(full_path).query
            params = urllib.parse.parse_qs(qs)
            days = int(params.get('days', ['30'])[0])
            history = {}
            if POLLERS_AVAILABLE:
                from db import get_usage_history
                # Get history for all active pollers
                providers = [p.provider for p in POLLER_INSTANCES]
                # Also include providers from usage.json if not in active list?
                # Just stick to pollers for now.
                for prov in providers:
                    history[prov] = get_usage_history(prov, 'cost_usd', days)
            self.send_json({'history': history})
            return

        # Blog / Dashboard settings / Notes endpoints
        if path in ['/proxy/blog/posts', '/proxy/blog/rss']:
            output = get_blog_posts()
            self.send_json(output)
            return

        if path in ['/proxy/dashboard/settings']:
            output = {'settings': load_settings_file()}
            self.send_json(output)
            return

        if path == '/proxy/openclaw/notes':
            index = read_notes_index()
            self.send_json({'notes': index.get('notes', [])})
            return

        if path.startswith('/proxy/openclaw/notes/raw'):
            try:
                qs = urllib.parse.urlparse(full_path).query
                params = urllib.parse.parse_qs(qs)
                p = params.get('path', [''])[0]
                p = urllib.parse.unquote(p)
                if not p:
                    self.send_json({'error': 'Missing path'}, 400)
                    return
                abs_p = os.path.abspath(p)
                allowed_prefixes = [os.path.abspath(WORKSPACE_DIR), os.path.abspath(DASHBOARD_DIR)]
                if not any(abs_p.startswith(pref) for pref in allowed_prefixes):
                    self.send_json({'error': 'Access denied'}, 403)
                    return
                if not os.path.exists(abs_p):
                    self.send_json({'error': 'Not found'}, 404)
                    return
                with open(abs_p, 'r', encoding='utf-8') as f:
                    content = f.read()
                self.send_json({'path': abs_p, 'content': content})
            except Exception as e:
                self.send_json({'error': str(e)}, 500)
            return

        if path == '/proxy/openclaw/history':
            output = get_schedule_history()
            self.send_json(output)
            return

        if path.startswith('/proxy/memory/search'):
            qs = urllib.parse.urlparse(full_path).query
            params = urllib.parse.parse_qs(qs)
            q = params.get('query', [''])[0]
            q = urllib.parse.unquote(q)
            if not q:
                self.send_json({'results': []})
                return
            res = memory_search(q)
            self.send_json(res)
            return

        if path.startswith('/proxy/logs'):
            qs = urllib.parse.urlparse(full_path).query
            params = urllib.parse.parse_qs(qs)
            lines = int(params.get('lines', ['200'])[0])
            content = tail_lines(LOG_PATH, lines)
            self.send_json({'lines': content.splitlines()})
            return

        if path in ['/proxy/usage', '/proxy/usage/']:
            summary = {}
            events = []
            try:
                if os.path.exists(USAGE_SUMMARY_PATH):
                    with open(USAGE_SUMMARY_PATH, 'r', encoding='utf-8') as f:
                        summary = json.load(f)
            except Exception as e:
                log(f"[Usage] failed to read summary: {e}")
            try:
                if os.path.exists(USAGE_LOG_PATH):
                    with open(USAGE_LOG_PATH, 'r', encoding='utf-8', errors='replace') as f:
                        lines = f.readlines()
                    raw = lines[-200:]
                    for l in raw:
                        try:
                            events.append(json.loads(l))
                        except:
                            events.append({'raw': l.strip()})
            except Exception as e:
                log(f"[Usage] failed to read log: {e}")
            self.send_json({'summary': summary, 'events': events})
            return

        if path in ['/proxy/ollama', '/proxy/ollama/']:
            output = get_ollama_usage()
            self.send_json(output)
            return

        super().do_GET()

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length) if content_length > 0 else b''
        body_data = json.loads(body) if body else {}
        path = self.path.split('?')[0]

        if path == '/proxy/pollers/run':
            provider = body_data.get('provider')
            result = {'status': 'not_found'}
            for p in POLLER_INSTANCES:
                if p.provider.lower() == provider.lower():
                    try:
                        log(f"[Pollers] Manual run triggered for {p.provider}")
                        run_res = p.run()
                        result = run_res
                    except Exception as e:
                        result = {'status': 'error', 'error': str(e)}
                    break
            self.send_json(result)
            return

        if path in ['/proxy/openclaw/cron/run', '/proxy/openclaw/api/cron/run']:
            job_id = body_data.get('jobId', '')
            output = run_openclaw_cmd(['cron', 'run', job_id, '--json'])
            self.send_json(output)
            return
        elif path in ['/proxy/openclaw/sessions/spawn', '/proxy/openclaw/api/sessions/spawn']:
            agent_id = body_data.get('agentId', 'main')
            task = body_data.get('task', '')
            try:
                spawn_body = json.dumps({
                    "tool": "sessions_spawn",
                    "args": {"agentId": agent_id, "task": task}
                }).encode()
                req = urllib.request.Request(
                    "http://127.0.0.1:18789/tools/invoke",
                    data=spawn_body,
                    headers={
                        'Authorization': 'Bearer e6480b6c1a165f20104702b89466dffe518955ca2de08854',
                        'Content-Type': 'application/json'
                    },
                    method='POST'
                )
                with urllib.request.urlopen(req, timeout=30) as response:
                    result = json.loads(response.read().decode())
                    self.send_json(result)
            except Exception as e:
                self.send_json({'error': str(e)}, 500)
            return

        if path in ['/proxy/openclaw/sessions/terminate', '/proxy/openclaw/sessions/close']:
            session_key = body_data.get('sessionKey') or body_data.get('key') or ''
            if not session_key:
                self.send_json({'error': 'Missing sessionKey'}, 400)
                return
            try:
                result = run_openclaw_cmd(['sessions', 'close', session_key, '--json'])
                if result and not result.get('error'):
                    self.send_json(result)
                    return
            except Exception as e:
                log(f"[Sessions] CLI terminate failed: {e}")

            try:
                spawn_body = json.dumps({
                    "tool": "sessions_terminate",
                    "args": {"sessionKey": session_key}
                }).encode()
                req = urllib.request.Request(
                    "http://127.0.0.1:18789/tools/invoke",
                    data=spawn_body,
                    headers={
                        'Authorization': 'Bearer e6480b6c1a165f20104702b89466dffe518955ca2de08854',
                        'Content-Type': 'application/json'
                    },
                    method='POST'
                )
                with urllib.request.urlopen(req, timeout=30) as response:
                    result = json.loads(response.read().decode())
                    self.send_json(result)
                    return
            except Exception as e:
                self.send_json({'error': f'Failed to terminate session: {e}'} , 500)
            return

        if path in ['/proxy/dashboard/settings']:
            settings = body_data.get('settings', {})
            ok = save_settings_file(settings)
            if ok:
                threading.Thread(target=build_notes_index, daemon=True).start()
                self.send_json({'ok': True})
            else:
                self.send_json({'error': 'Failed to write settings'}, 500)
            return

        if path == '/proxy/openclaw/reindex':
            idx = build_notes_index()
            self.send_json({'ok': True, 'indexed': len(idx.get('notes', []))})
            return

        if path in ['/proxy/ollama/cloud', '/proxy/ollama/cloud/']:
            session_usage = body_data.get('session_usage')
            session_reset = body_data.get('session_reset')
            weekly_usage = body_data.get('weekly_usage')
            weekly_reset = body_data.get('weekly_reset')
            ok = save_ollama_cloud_usage(session_usage, session_reset, weekly_usage, weekly_reset)
            if ok:
                self.send_json({'ok': True})
            else:
                self.send_json({'error': 'Failed to save Ollama usage'}, 500)
            return

        self.send_json({'error': f'Not found: {path}'}, 404)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def log_message(self, format, *args):
        try:
            msg = format % args
            if '/proxy/' in msg:
                log(f"[Proxy] {msg}")
        except Exception:
            pass


if __name__ == '__main__':
    try:
        with open(LOG_PATH, 'a', encoding='utf-8') as f:
            f.write('')
    except Exception:
        pass

    # Initialize pollers
    init_pollers()

    # Start threads
    watcher = threading.Thread(target=notes_watcher, daemon=True)
    watcher.start()
    
    poller_thread = threading.Thread(target=poller_loop, args=(21600,), daemon=True) # 6 hours
    poller_thread.start()

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("0.0.0.0", PORT), ProxyHandler) as httpd:
        log(f"🔷 OpenClaw Dashboard running at http://0.0.0.0:{PORT}")
        log(f"   Billing Pollers: {len(POLLER_INSTANCES)} active")
        try:
            if not os.path.exists(NOTES_INDEX_PATH):
                build_notes_index()
        except Exception as e:
            log(f"[Init] notes index build error: {e}")
        httpd.serve_forever()
