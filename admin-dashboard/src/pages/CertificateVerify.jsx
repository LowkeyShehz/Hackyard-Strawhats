import React, { useState, useEffect, useRef } from 'react';
import { Link, useParams, useNavigate, useLocation } from 'react-router-dom';
import CredentialVerify from './CredentialVerify';
import { tokenFromLocation } from '../utils/credential';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

/** "1234" -> "XXXX XXXX 1234" */
function formatAadhaarLast4(last4) {
    const digits = String(last4 || '').replace(/\D/g, '').slice(-4);
    return digits.length === 4 ? `XXXX XXXX ${digits}` : null;
}

/**
 * /verify#<token>: signed credential, verified in the browser.
 * /verify and /verify/<hash>: certificate lookup by SHA-256 hash.
 */
export default function CertificateVerify() {
    const location = useLocation();
    const token = tokenFromLocation(location);

    return (
        <div className="verify-page">
            {token ? (
                <>
                    <Link to="/verify" className="verify-back">&larr; Check another certificate</Link>
                    <div className="page-header">
                        <h2>Verify Work Credential</h2>
                        <p>Signed proof of verified work days, checked against the issuer&apos;s public key</p>
                    </div>
                    <CredentialVerify token={token} />
                </>
            ) : (
                <HashVerify />
            )}
        </div>
    );
}

function HashVerify() {
    const { hash } = useParams();
    const navigate = useNavigate();
    // status: idle | loading | verified | notfound | error
    const [status, setStatus] = useState(hash ? 'loading' : 'idle');
    const [cert, setCert] = useState(null);
    const [errorMessage, setErrorMessage] = useState('');
    const [checkedHash, setCheckedHash] = useState('');
    const [manualHash, setManualHash] = useState(hash || '');
    const requestSeq = useRef(0);

    async function fetchCertificate(h) {
        const seq = ++requestSeq.current;
        setStatus('loading');
        setCert(null);
        setErrorMessage('');
        setCheckedHash(h);
        let res;
        try {
            res = await fetch(`${API_BASE_URL}/api/certificate/${encodeURIComponent(h)}/verify`);
        } catch {
            if (seq !== requestSeq.current) return;
            setErrorMessage('Could not reach the verification service. Check your connection and try again.');
            setStatus('error');
            return;
        }
        if (seq !== requestSeq.current) return;

        if (res.status === 404) {
            setStatus('notfound');
            return;
        }
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            if (seq !== requestSeq.current) return;
            setErrorMessage(`Could not reach the verification service (${body.error || `HTTP ${res.status}`}). Please try again.`);
            setStatus('error');
            return;
        }

        try {
            const data = await res.json();
            if (seq !== requestSeq.current) return;
            if (!data.verified || !data.certificate) {
                setStatus('notfound');
                return;
            }
            const c = data.certificate;
            const issued = c.issued_at ? new Date(c.issued_at) : null;
            setCert({
                workerName: c.worker_name,
                aadhaar: formatAadhaarLast4(c.aadhaar_last4),
                totalDays: c.total_verified_days,
                dateRange: c.date_range ? `${c.date_range.from} to ${c.date_range.to}` : '-',
                sites: (c.sites_worked || []).map(s => (typeof s === 'string' ? s : s.name || s.site_id)).filter(Boolean),
                bocwRef: c.bocw_reference || '-',
                issueDate: issued && !Number.isNaN(issued.getTime())
                    ? issued.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
                    : '-',
                hash: h,
            });
            setStatus('verified');
        } catch {
            if (seq !== requestSeq.current) return;
            setErrorMessage('The verification service returned an unexpected response. Please try again.');
            setStatus('error');
        }
    }

    useEffect(() => {
        if (hash) {
            setManualHash(hash);
            fetchCertificate(hash);
        } else {
            requestSeq.current++;
            setStatus('idle');
            setCert(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hash]);

    function handleManualVerify(e) {
        e.preventDefault();
        const input = manualHash.trim();
        if (!input) return;
        // A signed credential, alone or inside a /verify#<token> link, is verified in the browser
        const token = input.match(/eyJ[\w-]*\.[\w-]+\.[\w-]+/)?.[0];
        if (token) {
            navigate(`/verify#${token}`);
            return;
        }
        // A /verify/<hash> link or a bare hash
        const h = input.match(/\/verify\/([^/?#\s]+)/)?.[1] || input;
        if (h === hash) fetchCertificate(h); // same URL: re-check without a route change
        else navigate(`/verify/${encodeURIComponent(h)}`);
    }

    const loading = status === 'loading';
    const verified = status === 'verified';

    return (
        <div>
            <div className="page-header">
                <h2>Verify a Worker Certificate</h2>
                <p>Scan the QR code on the certificate with your phone camera, or paste its link or code below.</p>
            </div>

            {/* Manual entry: always available so another certificate can be checked */}
            <div className="card" style={{ marginBottom: '20px' }}>
                <h3 style={{ marginBottom: '6px' }}>{status === 'idle' ? 'Check a certificate' : 'Check another certificate'}</h3>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                    Accepts the verification link from the QR code, the signed credential, or the certificate hash printed on the PDF.
                </p>
                <form onSubmit={handleManualVerify} className="verify-form">
                    <input
                        className="search-input"
                        type="text"
                        placeholder="Paste link, credential or hash"
                        aria-label="Verification link, credential or hash"
                        autoComplete="off"
                        spellCheck={false}
                        value={manualHash}
                        onChange={e => setManualHash(e.target.value)}
                    />
                    <button className="btn btn-primary" type="submit" disabled={!manualHash.trim() || loading}>
                        Verify
                    </button>
                </form>
            </div>

            {status === 'idle' && (
                <div className="verify-steps">
                    <VerifyStep n="1" title="Scan the QR" text="Point any phone camera at the QR code on the certificate." />
                    <VerifyStep n="2" title="Checked on your device" text="The signature is checked in your browser against the issuer's public key." />
                    <VerifyStep n="3" title="See the result" text="Verified days, sites and dates, or a clear warning if anything was changed." />
                </div>
            )}

            {/* Loading */}
            {loading && (
                <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
                    <p style={{ color: 'var(--text-muted)' }}>Verifying certificate...</p>
                </div>
            )}

            {/* Network / API error: distinct from "not found" */}
            {status === 'error' && (
                <div className="card" role="alert" style={{ textAlign: 'center', padding: '32px 24px' }}>
                    <span className="badge pending" style={{ fontSize: '15px', padding: '8px 24px', borderRadius: '24px' }}>
                        Verification Unavailable
                    </span>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.6, marginTop: '16px' }}>
                        {errorMessage}
                    </p>
                    <button className="btn btn-outline btn-sm" style={{ marginTop: '16px' }} onClick={() => fetchCertificate(checkedHash)}>
                        Retry
                    </button>
                </div>
            )}

            {/* Result Card */}
            {(status === 'verified' || status === 'notfound') && (
                <div className="card">
                    {/* Status Badge */}
                    <div style={{ textAlign: 'center', marginBottom: '24px' }}>
                        {verified ? (
                            <span className="badge approved" style={{
                                fontSize: '15px',
                                padding: '8px 24px',
                                borderRadius: '24px',
                            }}>
                                Verified Certificate
                            </span>
                        ) : (
                            <span className="badge rejected" style={{
                                fontSize: '15px',
                                padding: '8px 24px',
                                borderRadius: '24px',
                            }}>
                                Certificate Not Found
                            </span>
                        )}
                    </div>

                    {verified && cert ? (
                        <>
                            <h2 style={{
                                textAlign: 'center',
                                fontSize: '20px',
                                fontWeight: 700,
                                marginBottom: '24px',
                            }}>
                                Work Attendance Certificate
                            </h2>

                            {/* Details Grid */}
                            <div style={{
                                display: 'grid',
                                gridTemplateColumns: '1fr 1fr',
                                gap: '20px',
                                marginBottom: '24px',
                            }}>
                                <DetailItem label="Worker Name" value={cert.workerName} fullWidth={!cert.aadhaar} />
                                {cert.aadhaar && <DetailItem label="Aadhaar" value={cert.aadhaar} />}
                                <DetailItem label="Total Verified Days" value={`${cert.totalDays} days`} />
                                <DetailItem label="Date Range" value={cert.dateRange} />
                                <DetailItem label="BOCW Reference" value={cert.bocwRef} fullWidth />
                                <DetailItem label="Issue Date" value={cert.issueDate} />
                                <DetailItem label="Sites Worked" value={cert.sites.join('; ') || '-'} fullWidth />
                            </div>

                            {/* SHA-256 Hash */}
                            <div style={{
                                background: 'var(--bg-input)',
                                border: '1px solid var(--border-color)',
                                borderRadius: 'var(--border-radius-sm)',
                                padding: '12px 16px',
                                marginBottom: '24px',
                            }}>
                                <p style={{
                                    fontSize: '11px',
                                    fontWeight: 600,
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.5px',
                                    color: 'var(--text-muted)',
                                    marginBottom: '6px',
                                }}>
                                    SHA-256 Certificate Hash
                                </p>
                                <p style={{
                                    fontSize: '12px',
                                    fontFamily: 'monospace',
                                    color: 'var(--text-secondary)',
                                    wordBreak: 'break-all',
                                    lineHeight: 1.5,
                                }}>
                                    {cert.hash}
                                </p>
                            </div>

                            {/* Triple Verification Badge */}
                            <div style={{
                                background: 'rgba(19, 136, 8, 0.06)',
                                border: '1px solid rgba(19, 136, 8, 0.2)',
                                borderRadius: 'var(--border-radius-sm)',
                                padding: '16px',
                                textAlign: 'center',
                            }}>
                                <div style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '8px',
                                    marginBottom: '6px',
                                }}>
                                    <span style={{ fontSize: '18px' }}>&#x1F6E1;</span>
                                    <span style={{
                                        fontSize: '14px',
                                        fontWeight: 700,
                                        color: '#138808',
                                    }}>
                                        Triple Verification&trade;
                                    </span>
                                </div>
                                <p style={{
                                    fontSize: '12px',
                                    color: 'var(--text-secondary)',
                                    lineHeight: 1.5,
                                }}>
                                    This certificate was verified through AI-powered facial recognition,
                                    GPS geofencing, and voice attestation via the Nirman Mitra platform.
                                </p>
                            </div>
                        </>
                    ) : (
                        <div style={{ textAlign: 'center', padding: '24px 0' }}>
                            <p style={{ fontSize: '48px', marginBottom: '16px' }}>&#x26A0;&#xFE0F;</p>
                            <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.6 }}>
                                Certificate not found. No certificate matches this hash.
                                <br />
                                Please check the QR code or hash and try again.
                            </p>
                            <p style={{ fontSize: '12px', fontFamily: 'monospace', color: 'var(--text-muted)', wordBreak: 'break-all', marginTop: '12px' }}>
                                {checkedHash}
                            </p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function VerifyStep({ n, title, text }) {
    return (
        <div className="verify-step">
            <span className="verify-step-num" aria-hidden="true">{n}</span>
            <div>
                <p className="verify-step-title">{title}</p>
                <p className="verify-step-text">{text}</p>
            </div>
        </div>
    );
}

function DetailItem({ label, value, fullWidth }) {
    return (
        <div style={fullWidth ? { gridColumn: '1 / -1' } : {}}>
            <p style={{
                fontSize: '11px',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                color: 'var(--text-muted)',
                marginBottom: '4px',
            }}>
                {label}
            </p>
            <p style={{ fontSize: '14px', color: 'var(--text-primary)' }}>
                {value}
            </p>
        </div>
    );
}
