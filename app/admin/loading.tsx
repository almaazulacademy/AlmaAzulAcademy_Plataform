export default function AdminLoading() {
  return (
    <div className="animate-pulse" aria-label="Carregando painel">
      <div className="h-3 w-28 rounded-full bg-ink/10" />
      <div className="mt-4 h-10 w-64 max-w-full rounded-2xl bg-ink/10" />
      <div className="mt-3 h-5 w-[32rem] max-w-full rounded-full bg-ink/10" />
      <div className="mt-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => <div key={index} className="h-40 rounded-3xl bg-white" />)}
      </div>
    </div>
  );
}
