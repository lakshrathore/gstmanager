import 'server-only';
import { z } from 'zod';
import { FEATURE_KEYS } from './models';

/** Super admin package form (also used partially for edits). */
export const PackageBody = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(500).optional().default(''),
  priceInr: z.coerce.number().min(0).max(10_000_000),
  durationDays: z.coerce.number().int().min(1).max(3650),
  limits: z.object({
    companies: z.coerce.number().int().min(0).max(100_000),
    users: z.coerce.number().int().min(0).max(100_000),
    returnsPerMonth: z.coerce.number().int().min(0).max(1_000_000),
  }),
  features: z.array(z.enum(FEATURE_KEYS)).default([]),
  isTrial: z.boolean().default(false),
  active: z.boolean().default(true),
});

export const IssueLicenseBody = z.object({
  packageId: z.string().min(1),
  count: z.coerce.number().int().min(1).max(100).default(1),
  /** Defaults to the package's duration. */
  durationDays: z.coerce.number().int().min(1).max(3650).optional(),
  issuedTo: z.string().max(120).optional(),
  note: z.string().max(500).optional(),
  /** Activate immediately for this organisation (count must be 1). */
  orgId: z.string().optional(),
});

export const LicenseAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('suspend') }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('revoke') }),
  z.object({ action: z.literal('extend'), days: z.coerce.number().int().min(-3650).max(3650) }),
  z.object({ action: z.literal('note'), issuedTo: z.string().max(120).optional(), note: z.string().max(500).optional() }),
  /** Set the add-ons on a license by hand (absolute numbers). */
  z.object({
    action: z.literal('extras'),
    companies: z.coerce.number().int().min(0).max(10_000), users: z.coerce.number().int().min(0).max(10_000), returnsPerMonth: z.coerce.number().int().min(0).max(100_000),
  }),
]);
