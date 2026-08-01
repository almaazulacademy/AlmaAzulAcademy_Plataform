import type { LucideIcon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";

type FeatureCardProps = {
  icon: LucideIcon;
  title: string;
  description: string;
};

export function FeatureCard({ icon: Icon, title, description }: FeatureCardProps) {
  return (
    <Card className="h-full bg-paper/70 transition-all duration-300 hover:-translate-y-1 hover:shadow-soft">
      <CardContent className="p-7 sm:p-8">
        <div className="mb-8 grid size-12 place-items-center rounded-2xl bg-forest text-white">
          <Icon className="size-5" />
        </div>
        <h3 className="text-xl font-semibold tracking-[-0.025em]">{title}</h3>
        <p className="mt-3 text-sm leading-6 text-ink/62">{description}</p>
      </CardContent>
    </Card>
  );
}
