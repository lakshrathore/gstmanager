import { sandboxConfigured } from '@/server/gst/gst-client/sandbox';
import { Validators } from '@/components/tools/Validators';

export default async function ToolsPage({ searchParams }: PageProps<'/tools'>) {
  const { tab } = await searchParams;
  return <Validators sandbox={sandboxConfigured()} initialTab={typeof tab === 'string' ? tab : undefined} />;
}
