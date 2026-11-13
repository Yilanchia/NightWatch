// Plugin entry for the Nightwatch investigator. The implementation lives in @nightwatch/agent so
// its budget and note helpers are unit-tested with the rest of the agent; this package exists so a
// profile bundle can name it without depending on subpath resolution at boot.
export * from '@nightwatch/agent/investigator'
