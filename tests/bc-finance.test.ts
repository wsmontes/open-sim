import {it,expect} from 'vitest';
import capture from '../src/adapters/reality/data/vancouver-actuals-2024.json';
import {readBcMunicipalActuals} from '../src/adapters/reality/bc-finance';
import {CITY_IDENTITIES} from '../src/client/source-selection';
it('BC actual is distinct from approved budget',()=>expect(readBcMunicipalActuals(capture,CITY_IDENTITIES.Q24639)).toMatchObject([{year:2024,revenueCad:3164278000,expenseCad:2303644000,status:'actual'}]));
it('rejects wrong municipality',()=>expect(readBcMunicipalActuals(capture,CITY_IDENTITIES.Q2132)).toEqual([]));
it('leaves missing totals absent',()=>expect(readBcMunicipalActuals(capture.slice(0,1),CITY_IDENTITIES.Q24639)[0].expenseCad).toBeUndefined());
