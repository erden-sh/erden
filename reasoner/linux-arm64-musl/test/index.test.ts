import { testPlatformPackage } from '../../distribution/test/platform.js';

testPlatformPackage(new URL('../', import.meta.url));
