CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_email_lower ON admin_users(lower(email));
