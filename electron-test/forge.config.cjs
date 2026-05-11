module.exports = {
  packagerConfig: {
    name: 'QPJoy Tunnel NPM Test',
    executableName: 'qpjoy-tunnel-npm-test',
    asar: true,
    extraResource: [
      'node_modules/@qpjoy/electron-tunnel/resources/engine'
    ]
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin']
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin']
    },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: {
        options: {
          maintainer: 'QPJoy',
          homepage: 'https://qpjoy.local'
        }
      }
    }
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {}
    }
  ]
};
