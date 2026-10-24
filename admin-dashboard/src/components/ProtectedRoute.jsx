import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { homeForRole } from '../utils/roles';

/**
 * Requires a logged-in user. With `roles`, users with any other role are sent to their own
 * home page (the server enforces the same rule on every API call).
 */
export default function ProtectedRoute({ children, roles }) {
  const { isAuthenticated, loading, admin } = useAuth();

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        color: 'var(--text-muted)',
        fontSize: '14px',
      }}>
        Loading...
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (roles && !roles.includes(admin?.role)) {
    return <Navigate to={homeForRole(admin?.role)} replace />;
  }

  return children;
}
