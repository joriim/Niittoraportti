// Tuottaa Sentinel-2 L2A -testikuvat (keksittyä dataa). Aja: node test/fixtures/make_s2_fixtures.js
// B04 ja B08 10 m, SCL 20 m, EPSG:32635. Arvoissa prosessointiversion 04.00 siirtymä +1000.
const fs = require('fs');
const path = require('path');
const D = __dirname;
const OX = 289800, OY = 6965400;

function write(name, w, h, res, fn) {
  const v = new Uint16Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) v[r * w + c] = fn(OX + (c + 0.5) * res, OY - (r + 0.5) * res);
  fs.writeFileSync(path.join(D, name), tiff16(v, w, h, res));
}
// Minimaalinen pakkaamaton 16-bittinen GeoTIFF (little-endian, yksi kaistale).
function tiff16(v, w, h, res) {
  const geo = [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32635];
  const scale = [res, res, 0], tie = [0, 0, 0, OX, OY, 0];
  const tags = [[256, 3, 1, w], [257, 3, 1, h], [258, 3, 1, 16], [259, 3, 1, 1], [262, 3, 1, 1], [273, 4, 1, 0],
    [277, 3, 1, 1], [278, 3, 1, h], [279, 4, 1, w * h * 2], [339, 3, 1, 1],
    [33550, 12, 3, scale], [33922, 12, 6, tie], [34735, 3, geo.length, geo]];
  const ifdLen = 2 + tags.length * 12 + 4, extra = (3 + 6) * 8 + geo.length * 2;
  const dataOff = 8 + ifdLen + extra, buf = Buffer.alloc(dataOff + w * h * 2);
  buf.write('II', 0); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(8, 4);
  let p = 8, ext = 8 + ifdLen; buf.writeUInt16LE(tags.length, p); p += 2;
  tags.forEach(([tag, type, count, val]) => {
    buf.writeUInt16LE(tag, p); buf.writeUInt16LE(type, p + 2); buf.writeUInt32LE(count, p + 4);
    if (Array.isArray(val)) {
      buf.writeUInt32LE(ext, p + 8);
      val.forEach((x) => { if (type === 12) { buf.writeDoubleLE(x, ext); ext += 8; } else { buf.writeUInt16LE(x, ext); ext += 2; } });
    } else if (tag === 273) buf.writeUInt32LE(dataOff, p + 8);
    else if (type === 3) buf.writeUInt16LE(val, p + 8); else buf.writeUInt32LE(val, p + 8);
    p += 12;
  });
  buf.writeUInt32LE(0, p);
  for (let i = 0; i < v.length; i++) buf.writeUInt16LE(v[i], dataOff + i * 2);
  return buf;
}
const refl = (ndvi, red = 1000) => [red, Math.round(red * (1 + ndvi) / (1 - ndvi))];
function scene(prefix, ndviFn, sclFn) {
  write(prefix + '.B04.tif', 60, 45, 10, (x, y) => refl(ndviFn(x, y))[0] + 1000);
  write(prefix + '.B08.tif', 60, 45, 10, (x, y) => refl(ndviFn(x, y))[1] + 1000);
  write(prefix + '.SCL.tif', 30, 23, 20, sclFn);
}
// 1) 10.7. NDVI 0,80, kasvillisuus (SCL 4)
scene('s2a', () => 0.80, () => 4);
// 2) 28.7. pohjoisosa pilvessä (SCL 9) → kelvollisia alle 50 %
scene('s2b', () => 0.30, (x, y) => (y > 6965080 ? 9 : 4));
// 3) 17.8. niitetty: NDVI 0,45, paljas maa ja kasvillisuus (SCL 5/4) kelpaavat
scene('s2c', () => 0.45, (x) => (x < 290150 ? 5 : 4));
// 17.8. sininen kanava (B02): pohjoisreunalla ohut usva (heijastus 0,15 > 0,10), muualla 0,04
write('s2c.B02.tif', 60, 45, 10, (x, y) => (y > 6965150 ? 1500 : 400) + 1000);
// 4) kokonaan pilvessä (SCL 9): NIR-kaistaa ei saa avata
scene('s2d', () => 0.30, () => 9);
console.log('Sentinel-2-testikuvat kirjoitettu');
