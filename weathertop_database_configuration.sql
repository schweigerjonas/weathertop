create database weathertop;

create table user_data (
	user_id serial primary key,
	email varchar unique not null,
	forename varchar not null,
	surname varchar not null,
	"password" varchar not null
);

create table station (
	id serial primary key,
	user_id integer not null,
	station_name varchar not null,
	latitude decimal not null,
	longitude decimal not null
);

create table station_data (
	station_id integer not null,
	entry_id serial not null,
	reading_time varchar not null,
	weather integer not null,
	temperature decimal not null,
	wind_speed decimal not null,
	wind_direction integer not null,
	air_pressure integer not null
);

create role dev_weathertop with login password 'weathertop_developer';

grant connect on database weathertop to dev_weathertop;

grant all on schema public to dev_weathertop;

grant all privileges on all tables in schema public to dev_weathertop;

grant usage, select on all sequences in schema public to dev_weathertop;