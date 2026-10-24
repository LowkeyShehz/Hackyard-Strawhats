import React, { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { homeForRole } from '../utils/roles';

/** Page to return to after login (e.g. an officer who opened a credential link), else the role's home */
function takePostLoginRedirect(role) {
  const next = sessionStorage.getItem('postLoginRedirect');
  sessionStorage.removeItem('postLoginRedirect');
  return next && next.startsWith('/verify') ? next : homeForRole(role);
}
import '../login.css';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { login, isAuthenticated, admin } = useAuth();
  const navigate = useNavigate();

  // Redirect if already logged in (declaratively, not via navigate() during render)
  if (isAuthenticated) {
    return <Navigate to={takePostLoginRedirect(admin?.role)} replace />;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const loggedIn = await login(email, password);
      navigate(takePostLoginRedirect(loggedIn?.role), { replace: true });
    } catch (err) {
      setError(err.message || 'Invalid credentials');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-root">
      <div className="login-bg-accent login-bg-accent--orange" />
      <div className="login-bg-accent login-bg-accent--green" />

      <div className="login-card">
        <div className="login-header">
          <div className="login-logo">&#x1F3D7;&#xFE0F;</div>
          <h1 className="login-title">Nirman Mitra</h1>
          <p className="login-subtitle">Admin Dashboard</p>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="login-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="admin@nirmanmitra.in"
              required
              autoComplete="email"
            />
          </div>

          <div className="login-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Enter password"
              required
              autoComplete="current-password"
            />
          </div>

          {error && <p className="login-error">{error}</p>}

          <button type="submit" className="login-btn" disabled={submitting}>
            {submitting ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div className="login-footer">
          <p>Nirman Mitra · Admin access only</p>
        </div>
      </div>
    </div>
  );
}
