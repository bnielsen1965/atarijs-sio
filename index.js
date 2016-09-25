// diskimage.js

module.exports = createApplication;

/**
 * Create module instance.
 * @return {object} The module instance.
 */
function createApplication(serialDevice) {
  var DiskImage = require('atarijs-disk-image');
  var SerialPort = require("serialport");


  var app = function() {};

  // delay between last byte and next that is needed to start new command frame
  var START_DELAY = 10000000;
  var ABORT_DELAY = 1000000000;

  var STATE_WAIT_CMD      = 1;
  var STATE_PROCESS_CMD   = 2;
  var STATE_READ_DATA     = 3;
  var STATE_PROCESS_DATA  = 4;

  var SIO_ACK       = 0x41;
  var SIO_NAK       = 0x4e;
  var SIO_COMPLETE  = 0x43;
  var SIO_ERR       = 0x45;

  var CMD_FORMAT           = 0x21;
  var CMD_FORMAT_MD        = 0x22;
  var CMD_POLL             = 0x3F;
  var CMD_WRITE            = 0x50;
  var CMD_READ             = 0x52;
  var CMD_STATUS           = 0x53;
  var CMD_WRITE_VERIFY     = 0x57;

  var DELAY_GETSECTOR_ACK       = 1000;
  var DELAY_GETSECTOR_COMPLETE  = 200;
  var DELAY_GETSECTOR_DATA      = 400;
  var DELAY_GETSECTOR_DONE      = 200;

  var MAXIMUM_DRIVES = 8;
  var drives = [];

  var readState = STATE_WAIT_CMD;
  var readBlock = null;
  var readHRTime = null;
  var writeHRTime = null;
  var writing = false;
  var readDataLength = null;
  var readDataCallback = null;

  var commandFrame = {
    deviceId: null,
    command: null,
    aux1: null,
    aux2: null,
    checksum: null
  };

  var port = new SerialPort(serialDevice, {
    baudRate: 19200,
    bufferSize: 1
  });


  // open errors will be emitted as an error event
  port.on('error', function(err) {
    console.log('Error: ', err.message);
  });


  // read data from serial port
  port.on('data', function (data) {
    // determine the delay since the last read
    var newHRTime = getHRTime();

    switch (readState) {
      case STATE_WAIT_CMD:
      readCommand(data, newHRTime - readHRTime);
      // note the time of this read
      readHRTime = newHRTime;
      break;

      case STATE_PROCESS_CMD:
      readHRTime = newHRTime;
      break;

      case STATE_READ_DATA:
      readData(data);
      readHRTime = newHRTime;
      break;

      case STATE_PROCESS_DATA:
      console.log('UNEXPECTED: ' + data.toString('hex'));
      break;

      default:
      if (newHRTime - readHRTime > ABORT_DELAY) {
        console.log('ABORT');
        readState = STATE_WAIT_CMD;
      }
      break;
    }

  });


  var readCommand = function readCommand(readData, delayHRTime) {
    if (delayHRTime > START_DELAY || !readBlock) {
      readBlock = readData;
    }
    else {
      // append byte to current block
      readBlock = Buffer.concat([readBlock, readData], readBlock.length + readData.length);
    }

    // if we have enough data for a block then process
    if (readBlock.length === 5) {
      if (bufferToCommandFrame(readBlock)) {
        readState = STATE_PROCESS_CMD;
        processCommand();
      }
      else {
        console.log('COMMAND CHECKSUM ERROR');
      }
      readBlock = null;
    }
    else if (readBlock.length > 5) {
      readBlock = null;
    }
  };


  var readData = function readData(data) {
    if (!readBlock) {
      readBlock = data;
    }
    else {
      // append byte to current block
      readBlock = Buffer.concat([readBlock, data], readBlock.length + data.length);
    }

    // if we have enough data for a block then process
    if (readBlock.length >= readDataLength) {
      readState = STATE_PROCESS_DATA;
      if (readDataCallback) {
        readDataCallback(readBlock);
      }
      else {
        resetCommandFrame();
      }
    }
  };


  // process a block
  //function processBlock(block) {
  var processCommand = function processCommand() {
    switch (commandFrame.command) {
      // get status
      case CMD_STATUS:
      if (commandFrame.deviceId >= 0x31 && commandFrame.deviceId <= 0x38) {
        getStatusCommand((commandFrame.deviceId & 0xf) - 1);
      }
      else {
        resetCommandFrame();
      }
      break;

      // read sector
      case CMD_READ:
      if (commandFrame.deviceId >= 0x31 && commandFrame.deviceId <= 0x38) {
        readSectorCommand((commandFrame.deviceId & 0xf) - 1);
      }
      else {
        resetCommandFrame();
      }
      break;

      // write sector
      case CMD_WRITE:
      case CMD_WRITE_VERIFY:
      if (commandFrame.deviceId >= 0x31 && commandFrame.deviceId <= 0x38) {
        writeSectorCommand((commandFrame.deviceId & 0xf) - 1);
      }
      else {
        resetCommandFrame();
      }
      break;

      // format
      case CMD_FORMAT:
      if (commandFrame.deviceId >= 0x31 && commandFrame.deviceId <= 0x38) {
        formatDriveCommand((commandFrame.deviceId & 0xf) - 1);
      }
      else {
        resetCommandFrame();
      }
      break;

      case 0:
      resetCommandFrame();
      break;

      default:
      console.log('DROP ' + commandFrame.command.toString(16) + ' : ' + commandFrame.deviceId.toString(16));
      resetCommandFrame();
    }
  };



  var getStatusCommand = function getStatusCommand(deviceId) {
    if (drives[deviceId]) {
      var statusBytes = drives[deviceId].getStatusBytes();
      startWriteBlock([
        {bytes: [SIO_ACK], delay: DELAY_GETSECTOR_ACK},{bytes: [SIO_COMPLETE], delay: DELAY_GETSECTOR_COMPLETE},
        {bytes: statusBytes, delay: DELAY_GETSECTOR_DATA},
        {bytes: [checkSum(statusBytes, statusBytes.length)], delay: DELAY_GETSECTOR_DATA, wait: true}
      ], function() {
        resetCommandFrame();
      });
    }
    else {
      resetCommandFrame();
    }
  };


  var readSectorCommand = function readSectorCommand(deviceId) {
    if (drives[deviceId]) {
      var sectorNumber = (commandFrame.aux2 << 8) + commandFrame.aux1;
      var sectorData = drives[deviceId].getSector(sectorNumber);
      var sum = checkSum(sectorData, sectorData.length);
      startWriteBlock([
        {bytes: [SIO_ACK], delay: DELAY_GETSECTOR_ACK, wait: true},{bytes: [SIO_COMPLETE], delay: DELAY_GETSECTOR_COMPLETE},
        {bytes: sectorData, delay: DELAY_GETSECTOR_DATA},
        {bytes: [sum], delay: DELAY_GETSECTOR_DATA}
      ], function() {
        resetCommandFrame();
      });
    }
    else {
      resetCommandFrame();
    }
  };


  var writeSectorCommand = function writeSectorCommand(deviceId) {
    if (drives[deviceId]) {
      var writeDeviceId = deviceId;
      var sectorNumber = (commandFrame.aux2 << 8) + commandFrame.aux1;
      var sectorSize = drives[deviceId].getSectorSize(sectorNumber);

      readDataCallback = function(data) {
        readState = STATE_WAIT_CMD;
        drives[writeDeviceId].putSector(sectorNumber, data.slice(0,sectorSize));
        startWriteBlock([
          {bytes: [SIO_ACK], delay: DELAY_GETSECTOR_ACK},
          {bytes: [SIO_COMPLETE], delay: DELAY_GETSECTOR_COMPLETE}
        ], function() {
          resetCommandFrame();
        });
      };
      readDataLength = sectorSize; // sector size
      readState = STATE_READ_DATA;

      startWriteBlock([
        //{bytes: [SIO_COMPLETE], delay: DELAY_GETSECTOR_COMPLETE}
        {bytes: [SIO_ACK], delay: DELAY_GETSECTOR_ACK}
      ]);
    }
    else {
      resetCommandFrame();
    }
  };


  var formatDriveCommand = function formatDriveCommand(deviceId) {
    if (!drives[deviceId]) {
      drives[deviceId] = diskImage();
    }

    var sectorSize = drives[deviceId].getSectorSize();
    var sectorCount = drives[deviceId].getSectorCount();

    drives[deviceId].format(sectorSize, sectorCount);

    var response = new Uint8Array(sectorSize);
    response.fill(0xff);
    startWriteBlock([
      {bytes: [SIO_ACK], delay: DELAY_GETSECTOR_ACK},{bytes: [SIO_COMPLETE], delay: DELAY_GETSECTOR_COMPLETE},
      {bytes: response, delay: DELAY_GETSECTOR_DATA},
      {bytes: [checkSum(response, response.length)], delay: DELAY_GETSECTOR_DATA, wait: true}
    ], function() {
      resetCommandFrame();
    });
  };





  var startWriteBlock = function startWriteBlock(block, callback) {
    if (writing) {
      console.log('REJECT SERIAL WRITE');
      return;
    }
    writing = true;
    writeBlock(block, callback);
  };


  var writeBlock = function writeBlock(block, callback) {
    var data = block.shift();
    var writeDone = function() {
      if (block.length) {
        writeBlock(block, callback);
      }
      else {
        writing = false;
        if (callback) {
          callback();
        }
      }
    };

    if (data.delay) {
      waitUSec(getHRTime(), data.delay);
    }
    port.write(data.bytes, function() {
      if (data.wait) {
        port.drain(function() {
          writeDone();
        });
      }
    });

    if (!data.wait) {
      writeDone();
    }
  };


  var waitUSec = function waitUSec(startHRTime, uSeconds) {
    while (getHRTime() - startHRTime < uSeconds * 1000) {
      (function(){})(); // noop
    }
  };


  var getHRTime = function getHRTime() {
    var hrTime = process.hrtime();
    return hrTime[0] * 1000000000 + hrTime[1];
  };


  var bufferToCommandFrame = function bufferToCommandFrame(block) {
    if (checkSum(block, 4) !== block[4]) {
      return false;
    }

    commandFrame.deviceId = block[0];
    commandFrame.command = block[1];
    commandFrame.aux1 = block[2];
    commandFrame.aux2 = block[3];
    commandFrame.checksum = block[4];
    return true;
  };

  // calculate the checksum on the provided command frame block
  var checkSum = function checkSum(block, length) {
    var checksum = block[0];
    for (var i = 1; i < length; i++) {
      checksum = ((checksum + block[i]) >> 8) + ((checksum + block[i]) & 0xff);
    }
    return checksum;
  };

  var resetCommandFrame = function resetCommandFrame() {
    commandFrame.deviceId = null;
    commandFrame.command = null;
    commandFrame.aux1 = null;
    commandFrame.aux2 = null;
    commandFrame.checksum = null;
    readState = STATE_WAIT_CMD;
  };




  app.loadDrive = function loadDrive(drive, imagePath) {
    // CHANGE THIS TO THROW AN ERROR
    if (drive + 1 > MAXIMUM_DRIVES || drive < 0) {
      return ['Invalid drive number.'];
    }

    drives[drive] = DiskImage(imagePath);

    return null;
  };


  app.getStatus = function() {
    var status = {
      drives: []
    };

    for (var i = 0; i < MAXIMUM_DRIVES; i++) {
      status.drives[i] = {};
      if (drives[i]) {
        status.drives[i].filename = drives[i].getImageFilename();
        status.drives[i].sectorCount = drives[i].getSectorCount();
        status.drives[i].sectorSize = drives[i].getSectorSize(status.drives[i].sectorCount); // boot sectors may be smaller so use last sector
        status.drives[i].readOnly = drives[i].isReadOnly();
      }
    }

    return status;
  };


  app.exportImage = function(drive) {
    if (drive + 1 > MAXIMUM_DRIVES || drive < 0) {
      throw new Error('Invalid drive number.');
    }

    if (!drives[drive]) {
      throw new Error('No drive image.');
    }

    return drives[drive].exportImage();
  };


  app.importImage = function(drive, image, filePath) {
    if (drive + 1 > MAXIMUM_DRIVES || drive < 0) {
      throw new Error('Invalid drive number.');
    }

    if (!drives[drive]) {
      drives[drive] = DiskImage();
    }

    drives[drive].importImage(image, filePath);
  };


  app.saveImage = function(drive, filePath) {
    if (drive + 1 > MAXIMUM_DRIVES || drive < 0) {
      throw new Error('Invalid drive number.');
    }

    if (!drives[drive]) {
      throw new Error('No drive image.');
    }

    drives[drive].saveImage(filePath);
  };


  app.unloadImage = function(drive) {
    if (drive + 1 > MAXIMUM_DRIVES || drive < 0) {
      throw new Error('Invalid drive number.');
    }
    drives[drive].unloadImage(drive);
    drives[drive] = null;
  };



  return app;
}
