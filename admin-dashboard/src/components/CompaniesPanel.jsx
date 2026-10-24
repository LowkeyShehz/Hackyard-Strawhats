import React, { useState } from 'react';
import api from '../utils/api';
import { networkErrorMessage } from '../utils/events';

const EMPTY = { name: '', email: '', password: '' };
const labelStyle = { display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' };

/** Company accounts (view-only dashboard users) and a form to create one */
export default function CompaniesPanel({ companies, onChanged }) {
    const [form, setForm] = useState(EMPTY);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [saving, setSaving] = useState(false);

    function update(field, value) {
        setForm((f) => ({ ...f, [field]: value }));
        setError('');
        setSuccess('');
    }

    async function handleSubmit(e) {
        e.preventDefault();
        if (!form.name.trim() || !form.email.trim() || form.password.length < 10) {
            setError('Name, email and a password of at least 10 characters are required.');
            return;
        }
        setSaving(true);
        try {
            const res = await api.post('/api/admin/companies', {
                name: form.name.trim(), email: form.email.trim(), password: form.password,
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
            setSuccess(`Company "${body.company.name}" created. Share the login with them securely.`);
            setForm(EMPTY);
            onChanged();
        } catch (err) {
            setError(networkErrorMessage(err));
        }
        setSaving(false);
    }

    return (
        <div className="card">
            <h3 style={{ marginBottom: '4px' }}>Companies ({companies.length})</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                Construction companies get a view-only dashboard of the sites assigned to them.
            </p>

            <div className="table-container" style={{ marginBottom: '20px' }}>
                <table>
                    <thead><tr><th>Company</th><th>Login email</th><th>Sites</th></tr></thead>
                    <tbody>
                        {companies.map((c) => (
                            <tr key={c.company_id}>
                                <td><strong>{c.name}</strong><div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{c.company_id}</div></td>
                                <td>{c.email}</td>
                                <td>{c.site_ids.length}</td>
                            </tr>
                        ))}
                        {companies.length === 0 && (
                            <tr><td colSpan="3" style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>No companies yet.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>

            <form onSubmit={handleSubmit} noValidate>
                <h4 style={{ marginBottom: '12px' }}>Add company</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '12px' }}>
                    <div>
                        <label style={labelStyle} htmlFor="company-name">Company name</label>
                        <input id="company-name" className="search-input" style={{ width: '100%' }} value={form.name}
                            onChange={(e) => update('name', e.target.value)} placeholder="e.g. Surathkal Builders" />
                    </div>
                    <div>
                        <label style={labelStyle} htmlFor="company-email">Login email</label>
                        <input id="company-email" type="email" className="search-input" style={{ width: '100%' }} value={form.email}
                            onChange={(e) => update('email', e.target.value)} />
                    </div>
                    <div>
                        <label style={labelStyle} htmlFor="company-password">Password</label>
                        <input id="company-password" type="password" className="search-input" style={{ width: '100%' }} value={form.password}
                            onChange={(e) => update('password', e.target.value)} autoComplete="new-password" />
                    </div>
                </div>
                {error && <p role="alert" style={{ fontSize: '13px', color: 'var(--danger)', marginBottom: '12px' }}>{error}</p>}
                {success && <p role="status" style={{ fontSize: '13px', color: 'var(--success)', marginBottom: '12px' }}>{success}</p>}
                <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>{saving ? 'Creating...' : 'Create company'}</button>
            </form>
        </div>
    );
}
