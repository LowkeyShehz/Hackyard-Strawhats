/**
 * Nirman Mitra — Proactive Reminder Handler
 * Triggered by EventBridge schedule to find workers who missed their usual check-in
 * time and send them a WhatsApp template message.
 */

import config, { istDate } from '../utils/config.js';
import { queryItems, updateWorkerReminderTime } from '../utils/dynamodb.js';
import { sendTemplateMessage } from '../utils/whatsapp.js';

export const handler = async (event) => {
  console.log('ProactiveReminder event:', JSON.stringify(event));

  try {
    const now = new Date();
    const currentIsoTime = now.toISOString();
    const todayIst = istDate();

    // Query for active workers whose reminder time has passed
    // Requires a GSI on WorkersTable: ReminderIndex (status -> next_reminder_time)
    const pendingReminders = await queryItems(
      config.tables.workers,
      '#st = :active AND next_reminder_time <= :now',
      {
        ':active': 'ACTIVE',
        ':now': currentIsoTime,
      },
      'ReminderIndex',
      {
        expressionAttributeNames: { '#st': 'profile_status' }
      }
    );

    console.log(`Found ${pendingReminders.length} workers needing reminders.`);

    let sentCount = 0;
    const templateName = process.env.WHATSAPP_REMINDER_TEMPLATE_NAME || 'daily_checkin_reminder';

    for (const worker of pendingReminders) {
      // Safety check: if they already checked in today, don't send reminder
      if (worker.last_checkin_date === todayIst) {
        console.log(`Skipping worker ${worker.worker_id}, already checked in today.`);
      } else {
        // Send WhatsApp template message
        try {
          await sendTemplateMessage(worker.phone_number, templateName, worker.language || 'en');
          sentCount++;
          console.log(`Reminder sent to ${worker.worker_id}`);
        } catch (err) {
          console.error(`Failed to send reminder to ${worker.worker_id}:`, err.message);
        }
      }

      // Increment next_reminder_time by 24 hours so we don't spam them in the next cron run
      try {
        const nextTime = new Date(worker.next_reminder_time);
        nextTime.setUTCDate(nextTime.getUTCDate() + 1);
        await updateWorkerReminderTime(worker.worker_id, nextTime.toISOString());
      } catch (err) {
        console.error(`Failed to update reminder time for ${worker.worker_id}:`, err.message);
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Reminders processed', sentCount, totalProcessed: pendingReminders.length }),
    };

  } catch (err) {
    console.error('ProactiveReminder error:', err);
    return { statusCode: 500, error: err.message };
  }
};

export default { handler };
