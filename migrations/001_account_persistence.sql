CREATE TABLE server_chat_accounts (
  account_key text PRIMARY KEY CHECK (account_key ~ '^[a-z0-9_-]{3,20}$'),
  username text NOT NULL UNIQUE CHECK (char_length(username) BETWEEN 3 AND 20),
  password_salt text NOT NULL CHECK (password_salt ~ '^[a-f0-9]{32}$'),
  password_hash bytea NOT NULL,
  account_token text NOT NULL UNIQUE CHECK (account_token ~ '^[a-f0-9]{64}$'),
  created_at_ms bigint NOT NULL,
  legal_accepted_at_ms bigint NOT NULL,
  legal_terms_version text NOT NULL
);

CREATE TABLE server_chat_sessions (
  session_hash text PRIMARY KEY CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  account_key text NOT NULL REFERENCES server_chat_accounts(account_key) ON DELETE CASCADE,
  created_at_ms bigint NOT NULL
);

CREATE INDEX server_chat_sessions_account_idx
  ON server_chat_sessions (account_key);
