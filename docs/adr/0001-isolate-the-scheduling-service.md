# Isolate the scheduling service

Run the scheduler as a separate service on Jacob's existing paid server, with a dedicated Telnyx number, its own credentials, and its own durable state. The existing voice agent authenticates Jacob for administrative work, while this service admits outside callers for Calendar scheduling; combining them would couple different admission rules and capabilities. Reuse the telephone and hosting knowledge while accepting the small additional deployment surface needed to keep those responsibilities independent.
