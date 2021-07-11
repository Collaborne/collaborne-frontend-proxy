-- All users that are allowed to access this app
-- The 'id' field must be a valid github user
CREATE TABLE users (id VARCHAR PRIMARY KEY);
CREATE TABLE apps (id VARCHAR PRIMARY KEY, current VARCHAR, previous VARCHAR, latest VARCHAR, owner VARCHAR NOT NULL, autoupdate BOOLEAN DEFAULT FALSE);
CREATE TABLE versions (id VARCHAR NOT NULL, app VARCHAR NOT NULL, owner VARCHAR NOT NULL, upvotes INTEGER DEFAULT 0, downvotes INTEGER DEFAULT 0, PRIMARY KEY(id, app));
-- Issued access tokens for GitHub
-- Used by various API functions that need to query GitHub on behalf of a user.
CREATE TABLE github_tokens (id VARCHAR PRIMARY KEY, access_token VARCHAR NOT NULL, token_type VARCHAR NOT NULL, expires TIMESTAMP WITH TIME ZONE, refresh_token VARCHAR, scope VARCHAR);
