# Appointment Scheduling

People call Jacob's scheduling agent to learn when he is available and book an appointment with him.

## Language

**Caller**:
The person speaking with the scheduling agent over the phone.
_Avoid_: Customer, user

**Scheduling agent**:
The voice assistant that helps callers find availability and book appointments with Jacob.
_Avoid_: Server agent, administrative agent

**Scheduling call**:
The inbound phone conversation in which a caller discusses availability and arranges an appointment with the scheduling agent.

**Appointment**:
A scheduled 30-minute phone conversation that Jacob initiates by calling the other person's callback number.
_Avoid_: Meeting, booking

**Availability**:
Times Jacob permits callers to book and when he has no conflicting commitments.
_Avoid_: Empty calendar time

**Callback number**:
The phone number the caller supplies and confirms for Jacob to call at appointment time.
_Avoid_: Caller ID, verified identity

**Booking window**:
The period during which an appointment may start, bounded by the required advance notice and the maximum time into the future that callers may book.
_Avoid_: Working hours

**Booking confirmation**:
The caller's explicit agreement to the appointment details read back by the scheduling agent, authorizing the appointment to be created.
_Avoid_: Booking success

**Appointment ledger**:
The scheduler's durable record of each attempt to create an appointment and its outcome. It holds identities, start time, status and a salted callback-number hash, never caller speech, names or raw numbers.
_Avoid_: Booking store
