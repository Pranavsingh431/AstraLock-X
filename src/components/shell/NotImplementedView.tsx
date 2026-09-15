import { CircleDashed, Lock } from 'lucide-react';

import type { ViewDefinition } from '@/app/views';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

/**
 * Placeholder for a view that has not been built.
 *
 * It states plainly that nothing works yet and says what will land here and
 * when. It deliberately renders no charts, gauges or sample values: an empty
 * view is honest, whereas a placeholder full of invented numbers is not, and
 * the second kind has a way of surviving into a release.
 */
export function NotImplementedView({ view }: { view: ViewDefinition }): React.JSX.Element {
  const Icon = view.icon;

  return (
    <div className="flex h-full items-start justify-center overflow-auto p-8">
      <Card className="relative w-full max-w-2xl overflow-hidden">
        <Icon
          aria-hidden
          className="pointer-events-none absolute -top-6 -right-6 size-40 text-muted-foreground/5"
        />

        <CardHeader>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="border-dashed font-mono tracking-wide">
              <Lock aria-hidden />
              FUTURE WORK
            </Badge>
            <Badge variant="secondary" className="font-mono">
              Not part of this prototype
            </Badge>
            <Badge variant="outline" className="font-mono text-muted-foreground">
              Deferred to a later stage
            </Badge>
          </div>
          <CardTitle className="mt-2 text-xl">{view.label}</CardTitle>
          <CardDescription>{view.summary}</CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          <section>
            <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              What it would do
            </h3>
            <ul className="mt-3 space-y-2">
              {view.plannedCapabilities.map((capability) => (
                <li key={capability} className="flex gap-2.5 text-sm text-muted-foreground">
                  <CircleDashed aria-hidden className="mt-0.5 size-4 shrink-0 opacity-50" />
                  <span>{capability}</span>
                </li>
              ))}
            </ul>
          </section>

          {view.blockedBy.length > 0 && (
            <>
              <Separator />
              <section>
                <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  Requires first
                </h3>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {view.blockedBy.map((dependency) => (
                    <Badge key={dependency} variant="outline" className="font-normal">
                      {dependency}
                    </Badge>
                  ))}
                </div>
              </section>
            </>
          )}

          <Separator />
          <p className="text-xs leading-relaxed text-muted-foreground">
            This view is intentionally empty. It is scoped work that this prototype deliberately
            does not include, kept visible so the roadmap is legible rather than hidden — an
            unfinished tool presented as operational would be worse than an empty one.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
