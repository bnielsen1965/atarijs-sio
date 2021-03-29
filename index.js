const EventEmitter = require('events');
const DiskImage = require('atarijs-disk-image');
const SerialPort = require("serialport");

const MAX_DATA_DELAY = 10000000;
const ABORT_DELAY = 1000000000;
const MAXIMUM_DRIVES = 8;

const DELAY_GETSECTOR_ACK       = 1000;
const DELAY_GETSECTOR_COMPLETE  = 200;
const DELAY_GETSECTOR_DATA      = 400;
const DELAY_GETSECTOR_DONE      = 200;

const States = {
  WAIT_CMD: 1,
  PROCESS_CMD: 2,
  WAIT_SECTOR_DATA: 3,
  PROCESS_DATA: 4
};

const Commands = {
  FORMAT: 0x21,
  FORMAT_MD: 0x22,
  POLL: 0x3F,
  WRITE: 0x50,
  READ: 0x52,
  STATUS: 0x53,
  WRITE_VERIFY: 0x57
};

const Responses = {
  ACK: 0x41,
  NAK: 0x4e,
  COMPLETE: 0x43,
  ERR: 0x45
};

const Defaults = {
  serialPort: {
    baudRate: 19200,
    bufferSize: 1
  }
};

// class to control SIO interface
class SIO extends EventEmitter {
  constructor (serialDevice, settings) {
    super();
    this.settings = Object.assign({}, Defaults, settings);
    this.settings.serialPort = Object.assign({}, Defaults.serialPort, this.settings.serialPort);
    this.dataBlock = null;
    this.state = States.WAIT_CMD;
    this.lastHRTime = this.getHRTime();
    this.writing = false;
    this.writeSectorCommandFrame;
    this.drives = {};
    this.serialPortSetup(serialDevice);
  }

  serialPortSetup (serialDevice) {
    let _this = this;
    console.log(serialDevice, this.settings.serialPort)
    this.port = new SerialPort(serialDevice, this.settings.serialPort);
    // open errors will be emitted as an error event
    this.port.on('error', this.onSerialPortError.bind(this));
    this.port.on('data', this.onSerialPortData.bind(this));
  }

  onSerialPortError (error) {
    this.emit('error', `Serial port error, ${error.message}.`);
  }

  // event handler for incoming SIO data
  async onSerialPortData (data) {
    let previousHRTime = this.lastHRTime;
    this.lastHRTime = this.getHRTime();


    switch (this.state) {
      // waiting for command frame
      case States.WAIT_CMD:
        // waiting on command frame
        console.log('STATE_WAIT_CMD')
        if (this.lastHRTime - previousHRTime > MAX_DATA_DELAY) {
          console.log('RESET DATA BLOCK')
          this.dataBlock = null;
        }
        this.dataBlock = this.dataBlock ? Buffer.concat([this.dataBlock, data], this.dataBlock.length + data.length) : data;
        // check if enough bytes for a command frame
        if (this.dataBlock.length < 5) return;
        if (this.dataBlock.length > 5) {
          // nak?
          this.dataBlock = null;
          return;
        }
        this.state = States.PROCESS_CMD;
        try {
          this.state = await this.processCommandFrame(this.dataToCommandFrame(this.dataBlock));
        }
        catch (error) {
          this.emit('error', `Failed to process command frame. ${error.message}`);
          this.state = States.WAIT_CMD;
        }
        break;

      case States.PROCESS_CMD:
        console.log('STATE_PROCESS_CMD')
        if (this.lastHRTime - previousHRTime > MAX_DATA_DELAY) {
          console.log('RESET DATA BLOCK')
          // TODO nak? reset state?
          this.dataBlock = null;
          this.state = States.WAIT_CMD;
        }
        break;

      // waiting to receive sector data for a disk write command
      case States.WAIT_SECTOR_DATA:
        // read data for in progress write sector command
        console.log('STATE_WAIT_SECTOR_DATA')
        if (this.lastHRTime - previousHRTime > ABORT_DELAY) {
          console.log('RESET DATA BLOCK')
          // nak? reset state?
          this.dataBlock = null;
        }
        this.dataBlock = this.dataBlock ? Buffer.concat([this.dataBlock, data], this.dataBlock.length + data.length) : data;
        // if we have enough data for a block then process
        if (this.dataBlock.length < this.writeSectorCommandFrame.dataLength) return;
        this.state = States.PROCESS_DATA;
        try {
          await this.processSectorData(this.dataBlock, this.writeSectorCommandFrame);
        }
        catch (error) {
          this.emit('error', `Failed to process sector write data frame. ${error.message}`);
        }
        this.state = States.WAIT_CMD;
        break;

      case States.PROCESS_DATA:
        console.log('STATE_PROCESS_DATA')
        console.log('UNEXPECTED: ' + data.toString('hex'));
        break;

      default:
        console.log('STATE DEFAULT')
        if (this.lastHRTime - previousHRTime > MAX_DATA_DELAY) {
          console.log('ABORT')
          this.state = States.WAIT_CMD;
        }
        break;
    }

    this.dataBlock = null;
  }

  // convert 5 bytes of data to command frame
  dataToCommandFrame (data) {
    if (this.checksum(data, 4) !== data[4]) throw new Error('Checksum error in command frame.');
    return {
      driveNumber: data[0] & 0xf,
      deviceId: data[0],
      command: data[1],
      aux1: data[2],
      aux2: data[3],
      checksum: data[4]
    }
  }

  // calculate the checksum on the provided command frame data
  checksum (block, length) {
    let checksum = block[0];
    for (let i = 1; i < length; i++) checksum = ((checksum + block[i]) >> 8) + ((checksum + block[i]) & 0xff);
    return checksum;
  }

  async processCommandFrame (commandFrame) {
    switch (commandFrame.command) {
      // get status
      case Commands.STATUS:
      console.log('CMD_STATUS')
      if (commandFrame.deviceId >= 0x31 && commandFrame.deviceId <= 0x38) await this.getStatusCommand(commandFrame.driveNumber);
      break;

      // read sector
      case Commands.READ:
      console.log('CMD_READ')
      if (commandFrame.deviceId >= 0x31 && commandFrame.deviceId <= 0x38) await this.readSectorCommand(commandFrame);
      break;

      // write sector
      case Commands.WRITE:
      case Commands.WRITE_VERIFY:
      console.log('CMD_WRITE or CMD_WRITE_VERIFY')
      if (commandFrame.deviceId >= 0x31 && commandFrame.deviceId <= 0x38) return await this.writeSectorCommand(commandFrame);
      break;

      // format
      case Commands.FORMAT:
      console.log('CMD_FORMAT')
      if (commandFrame.deviceId >= 0x31 && commandFrame.deviceId <= 0x38) this.formatDriveCommand(commandFrame);
      break;

      case 0:
      console.log('CMD 0')
      this.state = States.WAIT_CMD;
      break;

      default:
      console.log('CMD DEFAULT')
      console.log('DROP ' + commandFrame.command.toString(16) + ' : ' + commandFrame.deviceId.toString(16));
    }
    return States.WAIT_CMD;
  }

  async processSectorData (data, commandFrame) {
    if (!this.drives[commandFrame.driveNumber - 1]) throw new Error(`Write sector failed, no drive ${commandFrame.driveNumber}.`);
    this.drives[commandFrame.driveNumber - 1].putSector(commandFrame.sectorNumber, data.slice(0, commandFrame.sectorSize));
    await this.writeBlocks([
      { bytes: [Responses.ACK], delay: DELAY_GETSECTOR_ACK },
      { bytes: [Responses.COMPLETE], delay: DELAY_GETSECTOR_COMPLETE }
    ]);
  }

  // get drive status
  async getStatusCommand (driveNumber) {
    if (this.drives[driveNumber - 1]) {
      let statusBytes = this.drives[driveNumber - 1].getStatusBytes();
      await this.writeBlocks([
        { bytes: [Responses.ACK], delay: DELAY_GETSECTOR_ACK },{ bytes: [Responses.COMPLETE], delay: DELAY_GETSECTOR_COMPLETE },
        { bytes: statusBytes, delay: DELAY_GETSECTOR_DATA },
        { bytes: [this.checksum(statusBytes, statusBytes.length)], delay: DELAY_GETSECTOR_DATA, wait: true }
      ]);
    }
  }

  // read drive sector
  async readSectorCommand (commandFrame) {
    if (!this.drives[commandFrame.driveNumber - 1]) throw new Error(`Read sector failed, no drive ${commandFrame.driveNumber}.`);
    let sectorNumber = (commandFrame.aux2 << 8) + commandFrame.aux1;
    let sectorData = this.drives[commandFrame.driveNumber - 1].getSector(sectorNumber);
    let sum = this.checksum(sectorData, sectorData.length);
    await this.writeBlocks([
      { bytes: [Responses.ACK], delay: DELAY_GETSECTOR_ACK, wait: true },{ bytes: [Responses.COMPLETE], delay: DELAY_GETSECTOR_COMPLETE * 100 },
      { bytes: sectorData, delay: DELAY_GETSECTOR_DATA },
      { bytes: [sum], delay: DELAY_GETSECTOR_DATA }
    ]);
  }

  // write drive sector
  async writeSectorCommand (commandFrame) {
    let driveIndex = commandFrame.driveNumber - 1;
    if (!this.drives[driveIndex]) throw new Error(`Write sector failed, no drive ${commandFrame.driveNumber}.`);
    // create the command frame for sector write
    this.writeSectorCommandFrame = commandFrame;
    this.writeSectorCommandFrame.sectorNumber = (commandFrame.aux2 << 8) + commandFrame.aux1;
    this.writeSectorCommandFrame.dataLength = this.drives[driveIndex].getSectorSize(this.writeSectorCommandFrame.sectorNumber);
    // acknowledge
    await this.writeBlocks([{ bytes: [Responses.ACK], delay: DELAY_GETSECTOR_ACK }]);
    return States.WAIT_SECTOR_DATA;
  }


  async formatDriveCommand (commandFrame) {
    let driveIndex = commandFrame.driveNumber - 1;
    if (!this.drives[driveIndex]) throw new Error(`Format disk failed, no drive ${commandFrame.driveNumber}.`);

    let sectorSize = this.drives[driveIndex].getSectorSize();
    let sectorCount = this.drives[driveIndex].getSectorCount();

    this.drives[driveIndex].format(sectorSize, sectorCount);

    let response = new Uint8Array(sectorSize);
    response.fill(0xff);
    await this.writeBlocks([
      { bytes: [Responses.ACK], delay: DELAY_GETSECTOR_ACK },{ bytes: [Responses.COMPLETE], delay: DELAY_GETSECTOR_COMPLETE },
      { bytes: response, delay: DELAY_GETSECTOR_DATA },
      { bytes: [this.checksum(response, response.length)], delay: DELAY_GETSECTOR_DATA, wait: true }
    ]);
  }




  // get status of drives
  getStatus () {
    let status = { drives: [] };
    for (let i = 0; i < MAXIMUM_DRIVES; i++) {
      status.drives[i] = {};
      if (this.drives[i]) {
        status.drives[i].filename = this.drives[i].getImageFilename();
        status.drives[i].sectorCount = this.drives[i].getSectorCount();
        status.drives[i].sectorSize = this.drives[i].getSectorSize(status.drives[i].sectorCount); // boot sectors may be smaller so use last sector
        status.drives[i].readOnly = this.drives[i].isReadOnly();
      }
    }
    return status;
  }

  // load drive image
  loadDrive (drive, imagePath) {
    // CHANGE THIS TO THROW AN ERROR
    if (drive + 1 > MAXIMUM_DRIVES || drive < 0) return ['Invalid drive number.'];
    this.drives[drive] = DiskImage(imagePath);
    return null;
  }

  exportImage (drive) {
    if (drive + 1 > MAXIMUM_DRIVES || drive < 0) throw new Error('Invalid drive number.');
    if (!this.drives[drive]) throw new Error('No drive image.');
    return this.drives[drive].exportImage();
  };


  importImage (drive, image, filePath) {
    if (drive + 1 > MAXIMUM_DRIVES || drive < 0) throw new Error('Invalid drive number.');
    if (!this.drives[drive]) this.drives[drive] = DiskImage();
    this.drives[drive].importImage(image, filePath);
  };


  saveImage (drive, filePath) {
    if (drive + 1 > MAXIMUM_DRIVES || drive < 0) throw new Error('Invalid drive number.');
    if (!this.drives[drive]) throw new Error('No drive image.');
    this.drives[drive].saveImage(filePath);
  };


  unloadImage (drive) {
    if (drive + 1 > MAXIMUM_DRIVES || drive < 0) throw new Error('Invalid drive number.');
    this.drives[drive].unloadImage(drive);
    this.drives[drive] = null;
  };




  // write SIO blocks
  async writeBlocks (blocks) {
    if (this.writing) throw new Error('SIO write failed, write is currently active.');
    this.writing = true;
    while (blocks.length) {
      let block = blocks.shift();
      // check if there is a delay before write
      if (block.delay) this.waitUSec(this.getHRTime(), block.delay);
      await this.writeBlock(block);
    }
    this.writing = false;
  }

  // write SIO block
  writeBlock (block) {
    return new Promise((resolve, reject) => {
      this.port.write(block.bytes, () => {
        // check if resolve should wait until port write is complete
        if (block.wait) this.port.drain(() => { resolve(); });
        else resolve();
      });
    });
  }



  // micro-second wait
  waitUSec (startHRTime, uSeconds) {
    while (this.getHRTime() - startHRTime < uSeconds * 1000) (function(){})(); // noop
  }

  // get high resolution time integer
  getHRTime () {
    let hrTime = process.hrtime();
    return hrTime[0] * 1000000000 + hrTime[1];
  }
}


module.exports = serialDevice => {
  console.log(serialDevice)
  return new SIO(serialDevice);
}
