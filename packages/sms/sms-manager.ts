import dayjs from "@calcom/dayjs";
import { getSenderId } from "@calcom/features/ee/workflows/lib/alphanumericSenderIdSupport";
import * as twilio from "@calcom/features/ee/workflows/lib/reminders/providers/twilioProvider";
import { checkSMSRateLimit } from "@calcom/lib/checkRateLimitAndThrowError";
import { SENDER_ID } from "@calcom/lib/constants";
import isSmsCalEmail from "@calcom/lib/isSmsCalEmail";
import { TimeFormat } from "@calcom/lib/timeFormat";
import prisma from "@calcom/prisma";
import type { CalendarEvent, Person } from "@calcom/types/Calendar";

const handleSendingSMS = async ({
  reminderPhone,
  smsMessage,
  senderID,
  teamId,
}: {
  reminderPhone: string;
  smsMessage: string;
  senderID: string;
  teamId: number;
}) => {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: {
      parent: {
        select: {
          isOrganization: true,
          organizationSettings: {
            select: {
              disablePhoneOnlySMSNotifications: true,
            },
          },
        },
      },
    },
  });

  if (!team?.parent?.isOrganization || team?.parent?.organizationSettings?.disablePhoneOnlySMSNotifications) {
    return; // resolves implicitly (as undefined)
  }

  try {
    await checkSMSRateLimit({
      identifier: `handleSendingSMS:team:${teamId}`,
      rateLimitingType: "sms",
    });

    const sms = await twilio.sendSMS(reminderPhone, smsMessage, senderID, teamId);
    return sms;
  } catch (e) {
    console.error("twilio.sendSMS failed", e);
    throw e; // propagate the error
  }
};

export default abstract class SMSManager {
  calEvent: CalendarEvent;
  isTeamEvent = false;
  teamId: number | undefined = undefined;

  constructor(calEvent: CalendarEvent) {
    this.calEvent = calEvent;
    this.teamId = this.calEvent?.team?.id;
    this.isTeamEvent = !!this.calEvent?.team?.id;
  }

  getFormattedTime(
    timezone: string,
    locale: string,
    time: string,
    format = `dddd, LL | ${TimeFormat.TWELVE_HOUR}`
  ) {
    return dayjs(time).tz(timezone).locale(locale).format(format);
  }

  getFormattedDate(timezone: string, locale: string) {
    return `${this.getFormattedTime(timezone, locale, this.calEvent.startTime)} - ${this.getFormattedTime(
      timezone,
      locale,
      this.calEvent.endTime
    )} (${timezone})`;
  }

  abstract getMessage(attendee: Person): string;

  async sendSMSToAttendee(attendee: Person) {
    const teamId = this.teamId;
    const attendeePhoneNumber = attendee.phoneNumber;
    const isPhoneOnlyBooking = attendeePhoneNumber && isSmsCalEmail(attendee.email);

    if (!this.isTeamEvent || !teamId || !attendeePhoneNumber || !isPhoneOnlyBooking) return;

    const smsMessage = this.getMessage(attendee);
    const senderID = getSenderId(attendeePhoneNumber, SENDER_ID);
    return handleSendingSMS({ reminderPhone: attendeePhoneNumber, smsMessage, senderID, teamId });
  }

  async sendSMSToAttendees() {
    if (!this.isTeamEvent) return;
    const smsToSend: Promise<unknown>[] = [];

    for (const attendee of this.calEvent.attendees) {
      smsToSend.push(this.sendSMSToAttendee(attendee));
    }

    await Promise.all(smsToSend);
  }
}
