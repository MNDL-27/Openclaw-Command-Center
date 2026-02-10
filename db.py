import sqlite3
import os
import time
import json

DB_PATH = "/home/protik/.openclaw/workspace/dashboard/usage.db"

def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    # Create tables if they don't exist
    c.execute('''
        CREATE TABLE IF NOT EXISTS usage_points (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            metric TEXT NOT NULL, -- e.g., 'cost_usd', 'tokens_total'
            value REAL NOT NULL,
            meta TEXT -- JSON blob for extra details (model breakdown etc)
        )
    ''')
    c.execute('CREATE INDEX IF NOT EXISTS idx_provider_ts ON usage_points (provider, timestamp)')
    conn.commit()
    conn.close()

def add_usage_point(provider, metric, value, meta=None):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    ts = int(time.time())
    meta_json = json.dumps(meta) if meta else "{}"
    c.execute('INSERT INTO usage_points (provider, timestamp, metric, value, meta) VALUES (?, ?, ?, ?, ?)',
              (provider, ts, metric, value, meta_json))
    conn.commit()
    conn.close()

def get_usage_history(provider, metric, days=30):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    cutoff = int(time.time()) - (days * 86400)
    c.execute('SELECT timestamp, value, meta FROM usage_points WHERE provider=? AND metric=? AND timestamp > ? ORDER BY timestamp ASC',
              (provider, metric, cutoff))
    rows = c.fetchall()
    conn.close()
    return [{'timestamp': r[0], 'value': r[1], 'meta': json.loads(r[2])} for r in rows]

def get_latest_usage(provider):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    # Get latest cost and optional token usage if available in the same or recent batch
    # We fetch the latest cost record
    c.execute('SELECT value, timestamp, meta FROM usage_points WHERE provider=? AND metric="cost_usd" ORDER BY timestamp DESC LIMIT 1', (provider,))
    cost_row = c.fetchone()
    
    # Try to find tokens record near same time
    tokens_val = 0
    if cost_row:
        ts = cost_row[1]
        c.execute('SELECT value FROM usage_points WHERE provider=? AND metric="tokens_total" AND timestamp >= ? AND timestamp <= ?', (provider, ts-5, ts+5))
        t_row = c.fetchone()
        if t_row:
            tokens_val = t_row[0]
            
    conn.close()
    
    if cost_row:
        return {
            'cost_usd': cost_row[0], 
            'timestamp': cost_row[1],
            'tokens_total': tokens_val,
            'meta': json.loads(cost_row[2]) if cost_row[2] else {}
        }
    return None
