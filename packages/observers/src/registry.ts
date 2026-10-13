import { ObserverAdapter } from "./adapter";
import { ObserverContext } from "./adapter";
import { assertObserverKind, validateObserverDeclarationShape } from "./compatibility";
import { ObserverDeclaration } from "../../contracts/src/scenario";
export type ObserverAdapterFactory = (context: ObserverContext) => ObserverAdapter;
export type ObserverDeclarationFactory = (
  declaration: ObserverDeclaration,
  context: ObserverContext
) => ObserverAdapter | undefined;
export interface ObserverDeclarationRegistration {
  kind: string;
  factory: ObserverDeclarationFactory;
  validate?: (declaration: ObserverDeclaration) => void;
}
export class ObserverRegistry {
  private adapters = new Map<string, ObserverAdapter | ObserverAdapterFactory>();
  private declarations = new Map<string, ObserverDeclarationFactory>();
  private validators = new Map<string, (declaration: ObserverDeclaration) => void>();
  constructor(registrations: ObserverDeclarationRegistration[] = []) {
    for (const registration of registrations)
      this.registerDeclarationFactory(
        registration.kind,
        registration.factory,
        registration.validate
      );
  }
  register(adapter: ObserverAdapter): void {
    assertObserverKind(adapter.kind);
    if (this.adapters.has(adapter.kind))
      throw new Error(`observer_adapter_already_registered:${adapter.kind}`);
    this.adapters.set(adapter.kind, adapter);
  }
  registerDeclarationFactory(
    kind: string,
    factory: ObserverDeclarationFactory,
    validate?: (declaration: ObserverDeclaration) => void
  ): void {
    assertObserverKind(kind);
    if (this.declarations.has(kind)) throw new Error(`observer_adapter_already_registered:${kind}`);
    this.declarations.set(kind, factory);
    if (validate) this.validators.set(kind, validate);
  }
  registerFactory(kind: string, factory: ObserverAdapterFactory): void {
    assertObserverKind(kind);
    if (this.adapters.has(kind)) throw new Error(`observer_adapter_already_registered:${kind}`);
    this.adapters.set(kind, factory);
  }
  get(kind: string): ObserverAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`observer_adapter_unavailable:${kind}`);
    if (typeof adapter === "function") return adapter({} as ObserverContext);
    return adapter;
  }
  create(kind: string, context: ObserverContext): ObserverAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`observer_adapter_unavailable:${kind}`);
    return typeof adapter === "function" ? adapter(context) : adapter;
  }
  createDeclaration(
    declaration: ObserverDeclaration,
    context: ObserverContext
  ): ObserverAdapter | undefined {
    return (
      this.declarations.get(declaration.kind)?.(declaration, context) ??
      (this.adapters.has(declaration.kind) ? this.create(declaration.kind, context) : undefined)
    );
  }
  supports(kind: string): boolean {
    return this.adapters.has(kind) || this.declarations.has(kind);
  }
  validateDeclaration(declaration: ObserverDeclaration): void {
    validateObserverDeclarationShape(declaration);
    if (!this.supports(declaration.kind))
      throw new Error(`observer_adapter_unavailable:${declaration.kind}`);
    this.validators.get(declaration.kind)?.(declaration);
    const factory = this.declarations.get(declaration.kind);
    if (!factory) return;
    let adapter: ObserverAdapter | undefined;
    try {
      adapter = factory(declaration, {
        runId: "observer-validation",
        experimentId: "observer-validation",
        variantId: "observer-validation",
        repetition: 1,
        phase: "measurement"
      });
    } catch (error) {
      throw new Error(`observer_factory_invalid:${declaration.id}:${String(error)}`);
    }
    if (!adapter || typeof adapter.ready !== "function" || typeof adapter.sample !== "function")
      throw new Error(`observer_lifecycle_invalid:${declaration.id}`);
  }
  list(): string[] {
    return [...new Set([...this.adapters.keys(), ...this.declarations.keys()])].sort();
  }
}
