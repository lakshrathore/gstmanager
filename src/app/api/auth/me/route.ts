import { api } from '@/server/http';
import { can, PERMISSIONS, type Permission } from '@/server/auth';
import { getGstClient } from '@/server/gst/gst-client';

export const GET = api('return:view', async (_req, { auth }) => ({
  user: { name: auth.name, email: auth.email, role: auth.role },
  permissions: (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(auth, p)),
  gstIntegration: getGstClient().id,
}));
