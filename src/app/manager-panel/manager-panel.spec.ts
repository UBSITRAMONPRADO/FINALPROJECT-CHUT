import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ManagerPanel } from './manager-panel';

describe('ManagerPanel', () => {
  let component: ManagerPanel;
  let fixture: ComponentFixture<ManagerPanel>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ManagerPanel],
    }).compileComponents();

    fixture = TestBed.createComponent(ManagerPanel);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
