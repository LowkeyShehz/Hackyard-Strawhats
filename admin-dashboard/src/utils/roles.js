/** Roles that use the admin / welfare officer dashboard */
export const ADMIN_ROLES = ['admin', 'super_admin'];

/** Construction companies: read-only view of their own sites */
export const COMPANY_ROLES = ['company'];

/** Landing page after login for a role */
export function homeForRole(role) {
    return COMPANY_ROLES.includes(role) ? '/company' : '/dashboard';
}
