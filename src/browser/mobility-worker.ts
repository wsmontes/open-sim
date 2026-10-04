import {buildNetworkJob,type NetworkRequest,type NetworkResult} from '../presentation/mobility-network-job';
const scope=globalThis as unknown as {onmessage:(event:{data:NetworkRequest})=>void;postMessage:(result:NetworkResult)=>void};
scope.onmessage=event=>scope.postMessage(buildNetworkJob(event.data));
