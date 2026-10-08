import test from 'node:test';
import assert from 'node:assert/strict';
import { ValidationPipe } from '@nestjs/common';
import { UpdateCameraDto } from '../src/cameras/dto/update-camera.dto';

test('opção visual aceita booleanos reais e não transforma string false em true', async () => {
  const pipe = new ValidationPipe({whitelist:true,transform:true,forbidNonWhitelisted:true,
    transformOptions:{enableImplicitConversion:true}});
  const metadata = {type:'body' as const,metatype:UpdateCameraDto};
  for (const value of [false,true]) {
    const result = await pipe.transform({showDetectorPercentage:value},metadata);
    assert.equal(result.showDetectorPercentage,value);
  }
  for (const value of ['false','true',0,1,{},[]]) {
    await assert.rejects(pipe.transform({showDetectorPercentage:value},metadata));
  }
});
