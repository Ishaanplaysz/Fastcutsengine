(function(root) {
  function filterHosts(offers, options) {
    return offers.filter(o => o.enabled &&
      (!options.available || (o.online && !o.busy && !o.own)) &&
      (options.kind === 'all' || o.kind === options.kind) &&
      (!options.gpu || o.gpuModel === options.gpu) &&
      (!options.cpu || o.cpuModel === options.cpu) &&
      o.ramMb >= options.ram && o.rate >= options.min * 1000 && o.rate <= options.max * 1000
    ).sort((a, b) => options.sort === 'name' ? a.name.localeCompare(b.name) :
      options.sort === 'ram' ? b.ramMb - a.ramMb :
      options.sort === 'price-desc' ? b.rate - a.rate : a.rate - b.rate);
  }
  if (typeof module !== 'undefined') module.exports = { filterHosts };
  else root.filterHosts = filterHosts;
})(globalThis);
