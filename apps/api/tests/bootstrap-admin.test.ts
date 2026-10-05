import test from 'node:test';
import assert from 'node:assert/strict';
import {parseInitialAdmin} from '../src/bootstrap-admin';
test('compiled bootstrap validates identity and refuses weak/malformed/oversized input',()=>{
  const input={username:'Customer.Admin',email:'',password:'Fixture-Only-12345',name:'Administrador'};
  assert.equal(parseInitialAdmin(JSON.stringify(input)).username,'customer.admin');
  assert.equal(parseInitialAdmin(JSON.stringify(input)).email,null);
  for(const changed of [{password:'admin123'},{username:'$(command)'},{email:'wrong'},{name:''},{password:123}]) {
    assert.throws(()=>parseInitialAdmin(JSON.stringify({...input,...changed})));
  }
  assert.throws(()=>parseInitialAdmin(' '.repeat(8193)));
});
