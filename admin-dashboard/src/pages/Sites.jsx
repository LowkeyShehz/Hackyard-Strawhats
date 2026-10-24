import React, { useState, useEffect, useCallback } from 'react';
import api from '../utils/api';
import { networkErrorMessage } from '../utils/events';
import CompaniesPanel from '../components/CompaniesPanel';

const EMPTY_FORM = { name: '', latitude: '', longitude: '', radius_meters: '200', is_active: true, company_id: '' };

function pick(site, ...keys) {
    for (const k of keys) {
        const v = k.split('.').reduce((o, part) => (o == null ? undefined : o[part]), site);
        if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
}

function fmtCoord(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(5) : '-';
}

/** Client-side checks mirroring the backend's validation; the server remains authoritative. */
function validate(form) {
    const errors = {};
    if (!form.name.trim()) errors.name = 'Name is required';
    const lat = Number(form.latitude);
    if (form.latitude === '' || !Number.isFinite(lat) || lat < -90 || lat > 90) errors.latitude = 'Latitude must be between -90 and 90';
    const lng = Number(form.longitude);
    if (form.longitude === '' || !Number.isFinite(lng) || lng < -180 || lng > 180) errors.longitude = 'Longitude must be between -180 and 180';
    const r = Number(form.radius_meters);
    if (form.radius_meters === '' || !Number.isFinite(r) || r <= 0) errors.radius_meters = 'Radius must be a positive number of metres';
    return errors;
}

const labelStyle = { display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' };
const fieldErrorStyle = { fontSize: '12px', color: 'var(--danger)', marginTop: '4px' };

export default function Sites() {
    const [sites, setSites] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [form, setForm] = useState(EMPTY_FORM);
    const [fieldErrors, setFieldErrors] = useState({});
    const [submitError, setSubmitError] = useState('');
    const [success, setSuccess] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [companies, setCompanies] = useState([]);
    const [assignError, setAssignError] = useState('');

    const fetchCompanies = useCallback(async () => {
        try {
            const res = await api.get('/api/admin/companies');
            if (!res.ok) return;
            const data = await res.json();
            setCompanies(data.companies || []);
        } catch {
            // The site list still works without the company list
        }
    }, []);

    useEffect(() => { fetchCompanies(); }, [fetchCompanies]);

    /** Assign or clear a site's company (re-sends the site's current details with the new company) */
    async function assignCompany(site, companyId) {
        setAssignError('');
        try {
            const res = await api.post('/api/admin/sites', {
                site_id: site.site_id,
                name: pick(site, 'name', 'site_name'),
                latitude: Number(pick(site, 'latitude')),
                longitude: Number(pick(site, 'longitude')),
                radius_meters: Number(pick(site, 'radius_meters')),
                is_active: pick(site, 'is_active') !== false,
                company_id: companyId || null,
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `HTTP ${res.status}`);
            }
            fetchSites();
            fetchCompanies();
        } catch (err) {
            setAssignError(networkErrorMessage(err));
        }
    }

    const fetchSites = useCallback(async () => {
        setLoading(true);
        setLoadError('');
        try {
            const res = await api.get('/api/admin/sites');
            if (res.status === 404) throw new Error('The sites API is not available on this backend yet.');
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${res.status}`);
            }
            const data = await res.json();
            setSites(Array.isArray(data) ? data : (data.sites || data.items || []));
        } catch (err) {
            setLoadError(networkErrorMessage(err));
        }
        setLoading(false);
    }, []);

    useEffect(() => { fetchSites(); }, [fetchSites]);

    function update(field, value) {
        setForm(prev => ({ ...prev, [field]: value }));
        setFieldErrors(prev => ({ ...prev, [field]: undefined }));
        setSuccess('');
    }

    async function handleSubmit(e) {
        e.preventDefault();
        setSubmitError('');
        setSuccess('');
        const errors = validate(form);
        setFieldErrors(errors);
        if (Object.keys(errors).length) return;

        setSubmitting(true);
        try {
            const res = await api.post('/api/admin/sites', {
                name: form.name.trim(),
                latitude: Number(form.latitude),
                longitude: Number(form.longitude),
                radius_meters: Number(form.radius_meters),
                is_active: !!form.is_active,
                ...(form.company_id && { company_id: form.company_id }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.error || (res.status === 404
                    ? 'The sites API is not available on this backend yet.'
                    : `HTTP ${res.status}`));
            }
            setSuccess(`Site "${form.name.trim()}" saved.`);
            setForm(EMPTY_FORM);
            fetchSites();
            fetchCompanies();
        } catch (err) {
            setSubmitError(networkErrorMessage(err));
        }
        setSubmitting(false);
    }

    return (
        <div>
            <div className="page-header">
                <h2>Sites</h2>
                <p>Construction sites and their geofences used for GPS attendance verification</p>
            </div>

            <div className="card" style={{ marginBottom: '20px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                        <h3>All Sites ({sites.length})</h3>
                        <button className="btn btn-outline btn-sm" onClick={fetchSites} disabled={loading}>{loading ? 'Loading...' : 'Refresh'}</button>
                    </div>
                    {assignError && (
                        <p role="alert" style={{ fontSize: '13px', color: 'var(--danger)', marginBottom: '12px' }}>
                            Could not update the company: {assignError}
                        </p>
                    )}
                    {loadError && (
                        <p role="alert" style={{ fontSize: '13px', color: 'var(--danger)', marginBottom: '12px' }}>
                            Could not load sites: {loadError}
                        </p>
                    )}
                    <div className="table-container">
                        <table>
                            <thead><tr><th>Name</th><th>Company</th><th>Location</th><th>Radius</th><th>Status</th></tr></thead>
                            <tbody>
                                {sites.map((s, i) => {
                                    const active = pick(s, 'is_active', 'active');
                                    return (
                                        <tr key={s.site_id || i}>
                                            <td>
                                                <strong>{pick(s, 'name', 'site_name') || '-'}</strong>
                                                {s.site_id && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{s.site_id}</div>}
                                            </td>
                                            <td>
                                                <select className="search-input" aria-label={`Company for ${pick(s, 'name', 'site_name')}`}
                                                    value={s.company_id || ''} onChange={(e) => assignCompany(s, e.target.value)}>
                                                    <option value="">None</option>
                                                    {companies.map((c) => <option key={c.company_id} value={c.company_id}>{c.name}</option>)}
                                                </select>
                                            </td>
                                            <td style={{ whiteSpace: 'nowrap' }}>
                                                {fmtCoord(pick(s, 'latitude', 'lat', 'location.latitude', 'location.lat'))},{' '}
                                                {fmtCoord(pick(s, 'longitude', 'lng', 'lon', 'location.longitude', 'location.lng'))}
                                            </td>
                                            <td>{pick(s, 'radius_meters', 'radius') ?? '-'} m</td>
                                            <td>
                                                <span className={`badge ${active === false ? 'rejected' : 'active'}`}>
                                                    {active === false ? 'inactive' : 'active'}
                                                </span>
                                            </td>
                                        </tr>
                                    );
                                })}
                                {!loading && sites.length === 0 && !loadError && (
                                    <tr><td colSpan="5" style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>No sites yet. Add one using the form below.</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px', alignItems: 'start' }}>
                <div className="card">
                    <h3 style={{ marginBottom: '16px' }}>Add Site</h3>
                    <form onSubmit={handleSubmit} noValidate>
                        <div style={{ marginBottom: '12px' }}>
                            <label style={labelStyle} htmlFor="site-name">Name</label>
                            <input id="site-name" className="search-input" style={{ width: '100%' }} value={form.name}
                                onChange={e => update('name', e.target.value)} placeholder="e.g. Greenfield Metro Station" />
                            {fieldErrors.name && <div style={fieldErrorStyle}>{fieldErrors.name}</div>}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                            <div>
                                <label style={labelStyle} htmlFor="site-lat">Latitude</label>
                                <input id="site-lat" className="search-input" style={{ width: '100%' }} inputMode="decimal" value={form.latitude}
                                    onChange={e => update('latitude', e.target.value)} placeholder="12.9716" />
                                {fieldErrors.latitude && <div style={fieldErrorStyle}>{fieldErrors.latitude}</div>}
                            </div>
                            <div>
                                <label style={labelStyle} htmlFor="site-lng">Longitude</label>
                                <input id="site-lng" className="search-input" style={{ width: '100%' }} inputMode="decimal" value={form.longitude}
                                    onChange={e => update('longitude', e.target.value)} placeholder="77.5946" />
                                {fieldErrors.longitude && <div style={fieldErrorStyle}>{fieldErrors.longitude}</div>}
                            </div>
                        </div>
                        <div style={{ marginBottom: '12px' }}>
                            <label style={labelStyle} htmlFor="site-radius">Radius (m)</label>
                            <input id="site-radius" className="search-input" style={{ width: '100%' }} inputMode="numeric" value={form.radius_meters}
                                onChange={e => update('radius_meters', e.target.value)} />
                            {fieldErrors.radius_meters && <div style={fieldErrorStyle}>{fieldErrors.radius_meters}</div>}
                        </div>
                        <div style={{ marginBottom: '12px' }}>
                            <label style={labelStyle} htmlFor="site-company">Company (optional)</label>
                            <select id="site-company" className="search-input" style={{ width: '100%' }} value={form.company_id}
                                onChange={e => update('company_id', e.target.value)}>
                                <option value="">None</option>
                                {companies.map((c) => <option key={c.company_id} value={c.company_id}>{c.name}</option>)}
                            </select>
                        </div>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', marginBottom: '16px' }}>
                            <input type="checkbox" checked={form.is_active} onChange={e => update('is_active', e.target.checked)} />
                            Active
                        </label>
                        {submitError && <p role="alert" style={{ fontSize: '13px', color: 'var(--danger)', marginBottom: '12px' }}>{submitError}</p>}
                        {success && <p role="status" style={{ fontSize: '13px', color: 'var(--success)', marginBottom: '12px' }}>{success}</p>}
                        <button className="btn btn-primary btn-sm" type="submit" disabled={submitting}>
                            {submitting ? 'Saving...' : 'Add Site'}
                        </button>
                    </form>
                </div>

                <CompaniesPanel companies={companies} onChanged={fetchCompanies} />
            </div>
        </div>
    );
}
