/**
 * Nirman Mitra — Auth Middleware
 * JWT verification, token generation, and password hashing.
 */

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createHash, randomUUID } from 'crypto';
import config from '../utils/config.js';
import { putItem, getItem, deleteItem, queryItems } from '../utils/dynamodb.js';

const SALT_ROUNDS = 12;

// bcrypt hash (same cost factor) of a random throwaway password. Compared against when the
// email is unknown, so a login for a missing account takes as long as one with a wrong password.
const DUMMY_PASSWORD_HASH = '$2b$12$7t9gWIE9Ce3qT/covSBtKOXZW2hc4YVJI84U/k0jax5Nol/1wx1qG';

/** Canonical form of an admin email: trimmed and lower-cased. */
export function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/**
 * Extract and verify the access token from the Authorization header.
 * Returns decoded payload { admin_id, email, role } or null.
 */
export function verifyAccessToken(event) {
  const authHeader = event.headers?.Authorization || event.headers?.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  try {
    return jwt.verify(match[1], config.jwt.secret);
  } catch {
    return null;
  }
}

/**
 * Check if the decoded token's role is in the allowed list.
 * Returns true if allowed, false otherwise.
 */
export function requireRole(decodedToken, allowedRoles) {
  if (!decodedToken || !decodedToken.role) return false;
  return allowedRoles.includes(decodedToken.role);
}

/**
 * Generate an access + refresh token pair for an admin.
 * Stores the refresh token hash in DynamoDB.
 */
export async function generateTokenPair(admin) {
  const accessToken = jwt.sign(
    {
      admin_id: admin.admin_id,
      email: admin.email,
      role: admin.role,
      // Company accounts carry their company, which scopes every /api/company/* query
      ...(admin.company_id && { company_id: admin.company_id }),
    },
    config.jwt.secret,
    { expiresIn: config.jwt.accessTokenExpiry },
  );

  const tokenId = randomUUID();
  const refreshToken = jwt.sign(
    { admin_id: admin.admin_id, token_id: tokenId },
    config.jwt.refreshSecret,
    { expiresIn: config.jwt.refreshTokenExpiry },
  );

  // Store hashed refresh token in DynamoDB
  const hashedToken = createHash('sha256').update(refreshToken).digest('hex');
  const ttl = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60; // 7 days

  await putItem(config.tables.refreshTokens, {
    token_id: hashedToken,
    admin_id: admin.admin_id,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
    ttl,
  });

  return { accessToken, refreshToken };
}

/**
 * Hash a plaintext password using bcrypt.
 */
export async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Compare a plaintext password against a bcrypt hash.
 * With no hash (unknown account) it still runs a full compare against a dummy hash and
 * returns false, keeping the response time independent of whether the account exists.
 */
export async function comparePassword(password, hash) {
  if (typeof password !== 'string') return false;
  if (!hash) {
    await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    return false;
  }
  return bcrypt.compare(password, hash);
}

/**
 * Look up a refresh token by its SHA-256 hash.
 */
export async function getRefreshToken(rawToken) {
  const hashedToken = createHash('sha256').update(rawToken).digest('hex');
  return getItem(config.tables.refreshTokens, { token_id: hashedToken });
}

/**
 * Delete a refresh token by its SHA-256 hash.
 */
export async function deleteRefreshToken(rawToken) {
  const hashedToken = createHash('sha256').update(rawToken).digest('hex');
  return deleteItem(config.tables.refreshTokens, { token_id: hashedToken });
}

/**
 * Look up an admin by email using the EmailIndex GSI.
 * The email is normalised first; admins stored before normalisation was introduced are
 * still found by their exact stored spelling.
 */
export async function getAdminByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const lookup = async (value) => {
    const items = await queryItems(
      config.tables.adminUsers,
      'email = :email',
      { ':email': value },
      'EmailIndex',
      { Limit: 1 },
    );
    return items.length > 0 ? items[0] : null;
  };
  const admin = await lookup(normalized);
  if (admin || normalized === email) return admin;
  return lookup(email);
}
