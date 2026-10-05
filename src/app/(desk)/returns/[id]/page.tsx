import { Workspace } from '@/components/workspace/Workspace';

export default async function Page({ params }: PageProps<'/returns/[id]'>) {
  const { id } = await params;
  return <Workspace id={id} />;
}
