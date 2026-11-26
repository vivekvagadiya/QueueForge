import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { UniqueConstraintError } from 'sequelize';
import { env } from '../config/env.js';
import { userRepository } from '../repositories/user.repository.js';
import { conflict, unauthorized } from '../utils/AppError.js';
import { serializeUser } from './serializers.js';

const JWT_ALGORITHM = 'HS256';

// Verified against when the email is unknown, so login takes similar time
// whether or not the account exists (limits user enumeration by timing).
let dummyHashPromise = null;
const getDummyHash = () => {
  dummyHashPromise ??= argon2.hash('queueforge-dummy-password', { type: argon2.argon2id });
  return dummyHashPromise;
};

const issueToken = (user) => ({
  accessToken: jwt.sign({}, env.JWT_SECRET, {
    algorithm: JWT_ALGORITHM,
    subject: user.id,
    issuer: env.JWT_ISSUER,
    expiresIn: env.JWT_EXPIRES_IN,
  }),
  tokenType: 'Bearer',
  expiresIn: env.JWT_EXPIRES_IN,
});

export const authService = {
  async register({ name, email, password }) {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    let user;
    try {
      user = await userRepository.create({ name, email, passwordHash });
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw conflict('An account with this email already exists', 'EMAIL_TAKEN');
      }
      throw err;
    }

    return { user: serializeUser(user), ...issueToken(user) };
  },

  async login({ email, password }) {
    const user = await userRepository.findByEmailWithPassword(email);

    if (!user) {
      await argon2.verify(await getDummyHash(), password);
      throw unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid || user.status !== 'ACTIVE') {
      throw unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    return { user: serializeUser(user), ...issueToken(user) };
  },

  /** Returns the active user for a bearer token, or throws 401. */
  async authenticate(token) {
    let claims;
    try {
      claims = jwt.verify(token, env.JWT_SECRET, {
        algorithms: [JWT_ALGORITHM],
        issuer: env.JWT_ISSUER,
      });
    } catch (err) {
      const expired = err instanceof jwt.TokenExpiredError;
      throw unauthorized(
        expired ? 'Access token has expired' : 'Invalid access token',
        expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN'
      );
    }

    const user = claims.sub ? await userRepository.findActiveById(claims.sub) : null;
    if (!user) {
      throw unauthorized('Invalid access token', 'INVALID_TOKEN');
    }

    return user;
  },
};
