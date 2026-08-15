import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "delete expired Community operations",
  { hours: 6 },
  internal.community.deleteExpiredOperations,
  {},
);

export default crons;
