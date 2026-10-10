CREATE TABLE IF NOT EXISTS site_content (
  property_id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  seo_title TEXT NOT NULL DEFAULT '',
  seo_description TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'instant',
  discount_pct REAL NOT NULL DEFAULT 0,
  base_guests INTEGER NOT NULL DEFAULT 2,
  extra_guest_pct REAL NOT NULL DEFAULT 0,
  refund_rules TEXT NOT NULL DEFAULT '[]',
  nonrefundable_pct REAL NOT NULL DEFAULT 0,
  whole_listing_id TEXT,
  room_content TEXT NOT NULL DEFAULT '{}',
  photo_keys TEXT NOT NULL DEFAULT '[]',
  gbp_link TEXT NOT NULL DEFAULT '',
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS direct_bookings (
  reference TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  status TEXT NOT NULL,
  property_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  listing_ids TEXT NOT NULL,
  arrival TEXT NOT NULL,
  departure TEXT NOT NULL,
  guests INTEGER,
  guest_name TEXT,
  guest_email TEXT,
  guest_phone TEXT,
  guest_note TEXT,
  price_breakdown TEXT NOT NULL,
  total_pence INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  provider TEXT,
  provider_payment_id TEXT,
  refunded_pence INTEGER NOT NULL DEFAULT 0,
  manage_token_hash TEXT,
  created_at TEXT,
  confirmed_at TEXT,
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_db_provider ON direct_bookings(provider, provider_payment_id);
CREATE TABLE IF NOT EXISTS checkout_holds (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL,
  property_id TEXT NOT NULL,
  listing_ids TEXT NOT NULL,
  arrival TEXT NOT NULL,
  departure TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  session_id TEXT
);
CREATE TABLE IF NOT EXISTS enquiries (
  id TEXT PRIMARY KEY,
  property_id TEXT,
  arrival TEXT,
  departure TEXT,
  guests INTEGER,
  name TEXT,
  email TEXT,
  phone TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS legal_pages (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  received_at TEXT
);
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_hits (
  k TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_hits ON rate_hits(k, ts);
