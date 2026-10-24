import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';
import { verifyCredential } from '../utils/credential';

const RESULT_STYLE = { maxWidth: '640px', marginBottom: '20px' };

function formatDate(epochSeconds) {
    if (!epochSeconds) return '-';
    return new Date(epochSeconds * 1000).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function Field({ label, value }) {
    return (
        <div>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>
                {label}
            </p>
            <p style={{ fontSize: '15px', color: 'var(--text-primary)', fontWeight: 500 }}>{value}</p>
        </div>
    );
}

/** Officer decision on a verified credential; recorded through the officer API */
function DecisionPanel({ credentialId }) {
    const { isAuthenticated } = useAuth();
    const [note, setNote] = useState('');
    const [state, setState] = useState({ status: 'idle', message: '' });

    // Every officer view goes into the audit log (PRD FR-7). Validity was already decided in the
    // browser; this call only records who looked, and returns any decision already made.
    useEffect(() => {
        if (!isAuthenticated || !credentialId) return;
        let cancelled = false;
        api.post('/api/officer/view', { jti: credentialId })
            .then((res) => (res.ok ? res.json() : null))
            .then((body) => {
                const previous = body?.decision;
                if (!cancelled && previous) {
                    const when = new Date(previous.at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
                    setState({ status: 'done', message: `This claim was already ${previous.decision === 'approve' ? 'approved' : 'rejected'} on ${when}.` });
                }
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [isAuthenticated, credentialId]);

    if (!isAuthenticated) {
        return (
            <div className="card" style={RESULT_STYLE}>
                <h3 style={{ marginBottom: '8px' }}>Record a decision</h3>
                <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                    Welfare board officers can approve or reject this claim after logging in.
                </p>
                <Link
                    className="btn btn-primary btn-sm"
                    to="/login"
                    onClick={() => sessionStorage.setItem('postLoginRedirect', window.location.pathname + window.location.hash)}
                >
                    Log in as officer
                </Link>
            </div>
        );
    }

    async function decide(decision) {
        setState({ status: 'saving', message: '' });
        try {
            const res = await api.post('/api/officer/approve', { jti: credentialId, decision, note: note.trim() });
            if (res.ok) {
                setState({ status: 'done', message: decision === 'approve' ? 'Claim approved and recorded.' : 'Claim rejected and recorded.' });
                return;
            }
            const body = await res.json().catch(() => ({}));
            setState({ status: 'error', message: body.error || `Could not record the decision (HTTP ${res.status}).` });
        } catch {
            setState({ status: 'error', message: 'Could not reach the server to record the decision. Please try again.' });
        }
    }

    const busy = state.status === 'saving';
    return (
        <div className="card" style={RESULT_STYLE}>
            <h3 style={{ marginBottom: '12px' }}>Record a decision</h3>
            {state.status === 'done' ? (
                <p role="status" style={{ fontSize: '14px', color: 'var(--green-dark)', fontWeight: 600 }}>{state.message}</p>
            ) : (
                <>
                    <textarea
                        className="search-input"
                        placeholder="Note (optional)"
                        aria-label="Decision note"
                        rows={2}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        style={{ width: '100%', marginBottom: '12px', resize: 'vertical' }}
                    />
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => decide('approve')}>Approve claim</button>
                        <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => decide('reject')}>Reject</button>
                    </div>
                    {state.status === 'error' && (
                        <p role="alert" style={{ fontSize: '13px', color: 'var(--danger)', marginTop: '12px' }}>{state.message}</p>
                    )}
                </>
            )}
        </div>
    );
}

/** Verifies a signed work credential entirely in the browser */
export default function CredentialVerify({ token }) {
    const [result, setResult] = useState({ status: 'verifying' });

    useEffect(() => {
        let cancelled = false;
        setResult({ status: 'verifying' });
        verifyCredential(token)
            .then((r) => { if (!cancelled) setResult({ status: 'verified', ...r }); })
            .catch((err) => { if (!cancelled) setResult({ status: 'failed', code: err.code, message: err.message }); });
        return () => { cancelled = true; };
    }, [token]);

    if (result.status === 'verifying') {
        return (
            <div className="card" style={{ ...RESULT_STYLE, textAlign: 'center', padding: '40px' }}>
                <p style={{ color: 'var(--text-muted)' }}>Checking the issuer's signature...</p>
            </div>
        );
    }

    if (result.status === 'failed') {
        return (
            <div className="card" role="alert" style={{ ...RESULT_STYLE, textAlign: 'center', padding: '32px 24px' }}>
                <span className="badge rejected" style={{ fontSize: '15px', padding: '8px 24px', borderRadius: '24px' }}>
                    {result.code === 'expired' ? 'Expired' : 'Not verified'}
                </span>
                <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.6, marginTop: '16px' }}>{result.message}</p>
            </div>
        );
    }

    const { payload, issuer, ms } = result;
    const subject = payload.vc?.credentialSubject || {};
    const sites = (subject.sites || []).join(', ') || '-';

    return (
        <>
            <div className="card" style={RESULT_STYLE}>
                <div style={{ textAlign: 'center', marginBottom: '24px' }}>
                    <span className="badge approved" style={{ fontSize: '16px', padding: '8px 28px', borderRadius: '24px' }}>
                        Verified
                    </span>
                    <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '12px' }}>
                        Signature checked in this browser in {ms} ms against the issuer's published key.
                    </p>
                </div>

                <h2 style={{ fontSize: '22px', marginBottom: '20px', textAlign: 'center' }}>{subject.name || '-'}</h2>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '18px' }}>
                    <Field label="Verified work days" value={subject.verifiedDays ?? '-'} />
                    <Field label="Period" value={subject.from && subject.to ? `${subject.from} to ${subject.to}` : '-'} />
                    <Field label="Aadhaar" value={subject.aadhaarLast4 ? `XXXX XXXX ${subject.aadhaarLast4}` : '-'} />
                    <Field label="Sites" value={sites} />
                    <Field label="Issued" value={formatDate(payload.iat)} />
                    <Field label="Valid until" value={formatDate(payload.exp)} />
                </div>

                <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '20px', wordBreak: 'break-all' }}>
                    Credential ID: {payload.jti || '-'} · Issuer: {issuer}
                </p>
            </div>

            <DecisionPanel credentialId={payload.jti} />
        </>
    );
}
