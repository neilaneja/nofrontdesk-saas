const GuestyAdapter = require('./guesty');
const HostawayAdapter = require('./hostaway');
const LodgifyAdapter = require('./lodgify');
const HospitableAdapter = require('./hospitable');
const OwnerRezAdapter = require('./ownerrez');
const EscapiaAdapter = require('./escapia');
const Beds24Adapter = require('./beds24');
const StreamlineAdapter = require('./streamline');
const HostfullyAdapter = require('./hostfully');
const AvantioAdapter = require('./avantio');

const adapters = {
  guesty: GuestyAdapter,
  hostaway: HostawayAdapter,
  lodgify: LodgifyAdapter,
  hospitable: HospitableAdapter,
  ownerrez: OwnerRezAdapter,
  escapia: EscapiaAdapter,
  beds24: Beds24Adapter,
  streamline: StreamlineAdapter,
  hostfully: HostfullyAdapter,
  avantio: AvantioAdapter,
};

function createAdapter(pmsType, credentials) {
  const AdapterClass = adapters[pmsType];
  if (!AdapterClass) {
    throw new Error(`Unsupported PMS type: ${pmsType}. Supported: ${Object.keys(adapters).join(', ')}`);
  }
  return new AdapterClass(credentials);
}

function getPMSList() {
  return [
    { id: 'guesty', name: 'Guesty', icon: 'guesty', fields: GuestyAdapter.getCredentialFields() },
    { id: 'hostaway', name: 'Hostaway', icon: 'hostaway', fields: HostawayAdapter.getCredentialFields() },
    { id: 'lodgify', name: 'Lodgify', icon: 'lodgify', fields: LodgifyAdapter.getCredentialFields() },
    { id: 'hospitable', name: 'Hospitable', icon: 'hospitable', fields: HospitableAdapter.getCredentialFields() },
    { id: 'ownerrez', name: 'OwnerRez', icon: 'ownerrez', fields: OwnerRezAdapter.getCredentialFields() },
    { id: 'escapia', name: 'Escapia', icon: 'escapia', fields: EscapiaAdapter.getCredentialFields() },
    { id: 'beds24', name: 'Beds24', icon: 'beds24', fields: Beds24Adapter.getCredentialFields() },
    { id: 'streamline', name: 'Streamline', icon: 'streamline', fields: StreamlineAdapter.getCredentialFields() },
    { id: 'hostfully', name: 'Hostfully', icon: 'hostfully', fields: HostfullyAdapter.getCredentialFields() },
    { id: 'avantio', name: 'Avantio', icon: 'avantio', fields: AvantioAdapter.getCredentialFields() },
  ];
}

module.exports = { createAdapter, getPMSList, adapters };
