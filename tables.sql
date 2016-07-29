-- All users that are allowed to access this app
-- The 'id' field must be a valid github user
CREATE TABLE users (id VARCHAR PRIMARY KEY);
CREATE TABLE apps (id VARCHAR PRIMARY KEY, current VARCHAR, previous VARCHAR, owner VARCHAR NOT NULL);
CREATE TABLE versions (id VARCHAR NOT NULL, app VARCHAR NOT NULL, upvotes INTEGER DEFAULT 0, downvotes INTEGER DEFAULT 0, PRIMARY KEY(id, app));
