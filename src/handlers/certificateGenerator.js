/**
 * Nirman Mitra — Certificate Generator Handler
 * Smart Certificate PDF with QR + SHA-256 at day threshold.
 * Auto-generated Smart Certificate issued at the attendance threshold.
 *
 * Trigger: Called by CertificateFlow Step Function or directly when
 * a worker's total_days_logged reaches CERTIFICATE_THRESHOLD (3 demo / 90 prod).
 *
 * Tasks:
 *   - check_eligibility: Verify worker has enough days
 *   - generate: Build PDF with QR + SHA-256 + upload to S3
 *   - verify: Public QR verification endpoint (delegated to adminApi)
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import config, { istDate } from '../utils/config.js';
import { getItem, putItem, queryItems, updateItem } from '../utils/dynamodb.js';
import { uploadToS3, generatePresignedUrl } from '../utils/s3.js';
import { issueWorkCredential, canIssueCredentials } from '../services/credential.js';

export const handler = async (event) => {
  console.log('CertificateGenerator event:', JSON.stringify(event).substring(0, 500));

  const { task, workerId } = event;

  try {
    switch (task) {
      case 'check_eligibility':
        return await checkEligibility(workerId);
      case 'generate':
        return await generateCertificate(workerId);
      default:
        return { statusCode: 400, error: `Unknown task: ${task}` };
    }
  } catch (err) {
    console.error(`CertificateGenerator error (${task}):`, err);
    return { statusCode: 500, error: err.message, task };
  }
};

// ---------------------------------------------------------
// Check Eligibility
// ---------------------------------------------------------

function isVerifiedLog(log) {
  return log.verification_status === 'auto_approved' || log.verification_status === 'approved';
}

async function checkEligibility(workerId) {
  const worker = await getItem(config.tables.workers, { worker_id: workerId });
  if (!worker) {
    return { eligible: false, reason: 'worker_not_found' };
  }

  // Count verified attendance logs, not the total_days_logged counter, which can drift from
  // what was actually verified
  const logs = await queryItems(
    config.tables.attendance,
    'worker_id = :wid',
    { ':wid': workerId },
  );
  const daysLogged = new Set(logs.filter(isVerifiedLog).map((l) => l.log_date)).size;
  const threshold = config.certificateThreshold;
  const eligible = daysLogged >= threshold;

  // Check if certificate already exists
  const existingCerts = await queryItems(
    config.tables.certificates,
    'worker_id = :wid',
    { ':wid': workerId },
  );

  if (existingCerts.length > 0) {
    return {
      eligible: false,
      reason: 'certificate_already_exists',
      certificateId: existingCerts[0].certificate_id,
      daysLogged,
      threshold,
    };
  }

  return { eligible, daysLogged, threshold, reason: eligible ? 'meets_threshold' : 'insufficient_days' };
}

// ---------------------------------------------------------
// Generate Certificate
// ---------------------------------------------------------

async function generateCertificate(workerId) {
  // Verify eligibility
  const eligibility = await checkEligibility(workerId);
  if (!eligibility.eligible) {
    return { success: false, ...eligibility };
  }

  // Claim issuance with a conditional write on the worker, so of two concurrent calls only one
  // issues a certificate; the other gets certificate_already_exists
  const certificateId = uuidv4();
  try {
    await updateItem(
      config.tables.workers,
      { worker_id: workerId },
      'SET certificate_claim = :cid',
      { ':cid': certificateId },
      undefined,
      'attribute_not_exists(certificate_claim)',
    );
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return { success: false, eligible: false, reason: 'certificate_already_exists' };
    }
    throw err;
  }

  try {
    return await issueCertificate(workerId, certificateId);
  } catch (err) {
    // Release the claim so a later request can retry
    await updateItem(config.tables.workers, { worker_id: workerId }, 'REMOVE certificate_claim', undefined)
      .catch((e) => console.error('[Certificate] Failed to release claim:', e.message));
    throw err;
  }
}

async function issueCertificate(workerId, certificateId) {
  const worker = await getItem(config.tables.workers, { worker_id: workerId });
  const workerName = worker.name || 'Unknown Worker';

  // Fetch all attendance logs
  const attendanceLogs = await queryItems(
    config.tables.attendance,
    'worker_id = :wid',
    { ':wid': workerId },
  );

  // Filter to approved logs only
  const approvedLogs = attendanceLogs.filter(isVerifiedLog);

  // Collect unique sites
  const sitesMap = new Map();
  for (const log of approvedLogs) {
    if (log.site_id && log.site_id !== 'unknown') {
      sitesMap.set(log.site_id, {
        site_id: log.site_id,
        name: log.site_name || log.site_id,
      });
    }
  }
  const sitesWorked = Array.from(sitesMap.values());

  // Date range
  const sortedDates = approvedLogs
    .map((l) => l.log_date)
    .filter(Boolean)
    .sort();
  const dateFrom = sortedDates[0] || istDate();
  const dateTo = sortedDates[sortedDates.length - 1] || istDate();

  // SHA-256 hash over the certificate data
  const certData = {
    certificateId,
    workerId,
    workerName,
    aadhaarLast4: worker.aadhaar_last4 || 'XXXX',
    totalDays: approvedLogs.length,
    dateFrom,
    dateTo,
    sitesWorked,
    issuedAt: new Date().toISOString(),
  };

  const verificationHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(certData))
    .digest('hex');

  // Generate BOCW reference number (mock for prototype)
  const bocwReference = `BOCW-${new Date().getFullYear()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

  // Signed credential: the QR carries the whole signed token, so an officer's browser can
  // verify it offline. Without a signing key, fall back to the hash lookup link.
  let credential = null;
  if (canIssueCredentials()) {
    credential = await issueWorkCredential({
      certificateId,
      workerId,
      workerName,
      aadhaarLast4: certData.aadhaarLast4,
      verifiedDays: approvedLogs.length,
      dateFrom,
      dateTo,
      sites: sitesWorked,
    });
  } else {
    console.warn('[Certificate] Signing key or PORTAL_URL missing; issuing an unsigned certificate');
  }
  const verificationUrl = credential ? credential.verifyUrl : getVerificationUrl(verificationHash);
  // Low error correction keeps the long token QR scannable from a phone screen
  const qrPng = await QRCode.toBuffer(verificationUrl, { type: 'png', margin: 2, width: 600, errorCorrectionLevel: 'L' });

  // Build PDF content
  const printedLink = credential ? `${config.portalUrl}/verify (scan the QR code)` : verificationUrl;
  const pdfBuffer = await buildCertificatePdf(certData, verificationHash, bocwReference, printedLink, qrPng);

  // Upload PDF to certificates S3 bucket
  const s3Key = `certificates/${workerId}/${certificateId}.pdf`;
  await uploadToS3(
    config.buckets.certificates,
    s3Key,
    pdfBuffer,
    'application/pdf',
    { worker_id: workerId, certificate_id: certificateId },
  );

  // QR as a standalone image, sent to the worker on WhatsApp to show the officer
  const qrS3Key = `certificates/${workerId}/${certificateId}-qr.png`;
  await uploadToS3(config.buckets.certificates, qrS3Key, qrPng, 'image/png', { worker_id: workerId, certificate_id: certificateId });

  // Store in Certificates table, with a snapshot of the worker's identity as printed on the PDF
  // (the verify endpoint shows these, even if the worker record changes later)
  const certificateRecord = {
    worker_id: workerId,
    certificate_id: certificateId,
    worker_name: workerName,
    aadhaar_last4: certData.aadhaarLast4,
    verification_hash: verificationHash,
    total_days: approvedLogs.length,
    date_from: dateFrom,
    date_to: dateTo,
    sites: sitesWorked,
    pdf_s3_key: s3Key,
    qr_code_data: verificationUrl,
    qr_s3_key: qrS3Key,
    credential_jwt: credential ? credential.token : null,
    bocw_reference: bocwReference,
    created_at: new Date().toISOString(),
  };

  await putItem(config.tables.certificates, certificateRecord);

  // Short-lived: WhatsApp delivery presigns its own link at send time from pdfS3Key
  const downloadUrl = await generatePresignedUrl(
    config.buckets.certificates,
    s3Key,
    900,
  );

  return {
    success: true,
    certificateId,
    verificationHash,
    bocwReference,
    totalDays: approvedLogs.length,
    dateRange: { from: dateFrom, to: dateTo },
    sitesWorked,
    downloadUrl,
    pdfS3Key: s3Key,
    qrS3Key,
    verificationUrl,
    signedCredential: Boolean(credential),
    workerName,
  };
}

/**
 * Portal page an officer opens to check the certificate. Without PORTAL_URL there is no public
 * host to point at, so the QR carries just the hash, which can be pasted into the verify page.
 */
function getVerificationUrl(verificationHash) {
  if (!config.portalUrl) {
    console.warn('[Certificate] PORTAL_URL is not set; QR code will contain only the hash');
    return verificationHash;
  }
  return `${config.portalUrl}/verify/${verificationHash}`;
}

// ---------------------------------------------------------
// PDF Builder — Real PDF via pdfkit
// ---------------------------------------------------------

function buildCertificatePdf(certData, verificationHash, bocwReference, verificationUrl, qrPng) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 50, left: 60, right: 60 },
    });

    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const centerX = doc.page.margins.left + pageWidth / 2;

    // --- Top border line ---
    doc
      .moveTo(doc.page.margins.left, 40)
      .lineTo(doc.page.width - doc.page.margins.right, 40)
      .lineWidth(3)
      .strokeColor('#1a5276')
      .stroke();

    // --- Title ---
    doc
      .fontSize(22)
      .font('Helvetica-Bold')
      .fillColor('#1a5276')
      .text('NIRMAN MITRA', 0, 55, { align: 'center', width: doc.page.width });

    doc
      .fontSize(14)
      .font('Helvetica')
      .fillColor('#2c3e50')
      .text('SMART WORK CERTIFICATE', 0, 82, { align: 'center', width: doc.page.width });

    doc
      .fontSize(9)
      .fillColor('#7f8c8d')
      .text('AI-Verified Proof of Employment for Construction Workers', 0, 102, { align: 'center', width: doc.page.width });

    // --- Divider ---
    doc
      .moveTo(doc.page.margins.left, 120)
      .lineTo(doc.page.width - doc.page.margins.right, 120)
      .lineWidth(1)
      .strokeColor('#bdc3c7')
      .stroke();

    // --- Certificate metadata ---
    let y = 138;
    const leftCol = doc.page.margins.left;
    const labelWidth = 150;

    function addField(label, value) {
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#2c3e50').text(label, leftCol, y);
      doc.fontSize(10).font('Helvetica').fillColor('#34495e').text(value, leftCol + labelWidth, y);
      y += 18;
    }

    addField('Certificate ID:', certData.certificateId);
    addField('BOCW Reference:', bocwReference);
    addField('Issue Date:', certData.issuedAt);

    // --- Section: Worker Details ---
    y += 8;
    doc
      .moveTo(leftCol, y)
      .lineTo(doc.page.width - doc.page.margins.right, y)
      .lineWidth(0.5)
      .strokeColor('#bdc3c7')
      .stroke();
    y += 10;

    doc.fontSize(13).font('Helvetica-Bold').fillColor('#1a5276').text('WORKER DETAILS', leftCol, y);
    y += 22;

    addField('Name:', certData.workerName);
    addField('Worker ID:', certData.workerId);
    addField('Aadhaar (Last 4):', `XXXX-XXXX-${certData.aadhaarLast4}`);

    // --- Section: Employment Record ---
    y += 8;
    doc
      .moveTo(leftCol, y)
      .lineTo(doc.page.width - doc.page.margins.right, y)
      .lineWidth(0.5)
      .strokeColor('#bdc3c7')
      .stroke();
    y += 10;

    doc.fontSize(13).font('Helvetica-Bold').fillColor('#1a5276').text('EMPLOYMENT RECORD', leftCol, y);
    y += 22;

    addField('Total Verified Days:', String(certData.totalDays));
    addField('Date Range:', `${certData.dateFrom} to ${certData.dateTo}`);
    addField('Sites Worked:', certData.sitesWorked.map((s) => s.name).join(', ') || 'N/A');

    // --- Section: Verification ---
    y += 8;
    doc
      .moveTo(leftCol, y)
      .lineTo(doc.page.width - doc.page.margins.right, y)
      .lineWidth(0.5)
      .strokeColor('#bdc3c7')
      .stroke();
    y += 10;

    doc.fontSize(13).font('Helvetica-Bold').fillColor('#1a5276').text('VERIFICATION', leftCol, y);
    y += 22;

    doc.fontSize(9).font('Helvetica-Bold').fillColor('#2c3e50').text('SHA-256 Hash:', leftCol, y);
    y += 14;
    doc.fontSize(8).font('Courier').fillColor('#7f8c8d').text(verificationHash, leftCol, y);
    y += 20;

    // --- QR Code ---
    const qrBoxSize = 140;
    const qrX = centerX - qrBoxSize / 2;
    doc.image(qrPng, qrX, y, { width: qrBoxSize, height: qrBoxSize });

    doc
      .fontSize(7)
      .font('Helvetica')
      .fillColor('#7f8c8d')
      .text(verificationUrl, 0, y + qrBoxSize + 6, { align: 'center', width: doc.page.width });

    y += qrBoxSize + 28;

    // --- Section: Triple Verification ---
    y += 8;
    doc
      .moveTo(leftCol, y)
      .lineTo(doc.page.width - doc.page.margins.right, y)
      .lineWidth(0.5)
      .strokeColor('#bdc3c7')
      .stroke();
    y += 10;

    doc.fontSize(13).font('Helvetica-Bold').fillColor('#1a5276').text('TRIPLE VERIFICATION\u2122', leftCol, y);
    y += 20;

    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor('#34495e')
      .text(
        'Each attendance log was verified through three independent AI channels: ' +
        'Facial Recognition, GPS Geo-Fencing, and Voice Intent Analysis. ' +
        'This certificate is tamper-resistant and legally defensible proof of employment.',
        leftCol,
        y,
        { width: pageWidth, lineGap: 3 },
      );

    y += 50;

    // --- Legal Disclaimer ---
    doc
      .fontSize(8)
      .font('Helvetica-Oblique')
      .fillColor('#95a5a6')
      .text(
        'This certificate is generated by the Nirman Mitra AI system. ' +
        'Verification: Use the SHA-256 hash or QR code to validate. ' +
        'Issued under the Building and Other Construction Workers (BOCW) Act, 1996.',
        leftCol,
        y,
        { width: pageWidth, lineGap: 2 },
      );

    // --- Bottom border ---
    const bottomY = doc.page.height - 40;
    doc
      .moveTo(doc.page.margins.left, bottomY)
      .lineTo(doc.page.width - doc.page.margins.right, bottomY)
      .lineWidth(3)
      .strokeColor('#1a5276')
      .stroke();

    doc
      .fontSize(8)
      .font('Helvetica')
      .fillColor('#7f8c8d')
      .text('Verified by AI  |  Powered by AWS  |  Zero Contractor Dependency', 0, bottomY + 6, {
        align: 'center',
        width: doc.page.width,
      });

    doc.end();
  });
}

export default { handler };
