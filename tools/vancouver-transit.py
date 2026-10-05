"""Bounded offline extraction; no browser importer limits are relaxed."""
import csv, io, json, sys, zipfile, hashlib
from collections import defaultdict
source, destination, report_path = sys.argv[1:]
with zipfile.ZipFile(source) as archive:
    def rows(name):
        return csv.DictReader(io.TextIOWrapper(archive.open(name), encoding='utf-8-sig', newline=''))
    files = {i.filename: {'expandedBytes': i.file_size, 'compressedBytes': i.compress_size} for i in archive.infolist()}
    if len(files)>64 or sum(i['expandedBytes'] for i in files.values())>128*1024*1024:
        raise ValueError('Official archive exceeds offline extraction budget')
    stops = list(rows('stops.txt'))
    selected_stops = {r['stop_id'] for r in stops if -123.27<=float(r['stop_lon'])<=-123.02 and 49.20<=float(r['stop_lat'])<=49.31}
    routes = {r['route_id']:r for r in rows('routes.txt') if r['route_type'] in ('3','4')}
    trips = {r['trip_id']:r for r in rows('trips.txt') if r['route_id'] in routes}
    legs = defaultdict(list)
    for r in rows('stop_times.txt'):
        if r['trip_id'] in trips:
            for field in ('arrival_time','departure_time'):r[field]=r[field].strip()
            legs[r['trip_id']].append(r)
    patterns = {}; touched_routes=set()
    for id, trip in trips.items():
        ordered=sorted(legs[id],key=lambda r:int(r['stop_sequence']))
        if not any(r['stop_id'] in selected_stops for r in ordered):continue
        key=(trip['route_id'],trip.get('shape_id',''),trip.get('direction_id',''),trip['service_id'],tuple(r['stop_id'] for r in ordered))
        if key not in patterns:patterns[key]=(trip,ordered)
        touched_routes.add(trip['route_id'])
    selected_trips=[p[0] for p in patterns.values()]; selected_legs=[r for p in patterns.values() for r in p[1]]
    used_stops={r['stop_id'] for r in selected_legs};used_shapes={r['shape_id'] for r in selected_trips if r.get('shape_id')}
    shapes=[r for r in rows('shapes.txt') if r['shape_id'] in used_shapes]
    output={'stops.txt':[r for r in stops if r['stop_id'] in used_stops], 'routes.txt':[r for id,r in routes.items() if id in touched_routes], 'trips.txt':selected_trips,'stop_times.txt':selected_legs,'shapes.txt':shapes}
    with zipfile.ZipFile(destination,'w',zipfile.ZIP_DEFLATED) as target:
        for name in ('agency.txt','calendar.txt','calendar_dates.txt','feed_info.txt'):
            target.writestr(name,archive.read(name))
        for name,data in output.items():
            if not data:raise ValueError('Empty selected table '+name)
            text=io.StringIO(newline='');writer=csv.DictWriter(text,fieldnames=list(data[0]));writer.writeheader();writer.writerows(data);target.writestr(name,text.getvalue())
    with open(report_path,'w') as report:
        json.dump({'sourceSha256':hashlib.sha256(open(source,'rb').read()).hexdigest(),'originalFiles':files,'selectionBounds':{'west':-123.27,'east':-123.02,'south':49.20,'north':49.31},'normalization':'Trim surrounding whitespace from official arrival/departure time fields; original archive hash retained', 'selection':'Bus/ferry trips touching capture box, one representative per route/shape/direction/service/stop sequence; complete selected shapes and stop sequences','rows':{name:len(data) for name,data in output.items()},'feedInfo':list(rows('feed_info.txt'))},report,indent=2)
