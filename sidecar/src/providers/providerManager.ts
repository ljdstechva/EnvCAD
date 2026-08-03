// Compatibility seam for the incremental migration. New code should use
// ProviderSupervisor; existing imports continue to receive the same implementation.
export {
  ProviderSupervisor,
  ProviderSupervisor as ProviderManager,
  type ProviderSupervisorOptions
} from './providerSupervisor'
